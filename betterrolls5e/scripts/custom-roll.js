import { i18n, isAttack, isSave, getSave, isCheck } from "./betterrolls5e.js";
import { DiceCollection, ActorUtils, ItemUtils, Utils } from "./utils.js";
import { Renderer } from "./renderer.js";

/**
 * Roll type for advantage/disadvantage/etc
 * @typedef {"highest" | "lowest" | null} RollState
 */

import { DND5E } from "../../../systems/dnd5e/module/config.js";

let dnd5e = DND5E;
let DEBUG = false;

const blankRoll = new Roll("0").roll(); // Used for CHAT_MESSAGE_TYPES.ROLL, which requires a roll that Better Rolls otherwise does not need

function debug() {
	if (DEBUG) {
		console.log.apply(console, arguments);
	}
}

function createChatData(actor, content, { hasMaestroSound = false }={}) {
	return {
		user: game.user._id,
		content: content,
		speaker: {
			actor: actor._id,
			token: actor.token,
			alias: actor.token?.name || actor.name
		},
		type: CONST.CHAT_MESSAGE_TYPES.ROLL,
		roll: blankRoll,
		...Utils.getWhisperData(),
		sound: Utils.getDiceSound(hasMaestroSound)
	};
}

/**
 * Returns an item and its actor if given an item, or just the actor otherwise.
 * @param {Item | Actor} actorOrItem
 */
function resolveActorOrItem(actorOrItem) {
	if (!actorOrItem) {
		return {};
	}

	if (actorOrItem instanceof Item) {
		return { item: actorOrItem, actor: actorOrItem?.actor };
	} else {
		return { actor: actorOrItem };
	}
}

/**
 * General class for macro support, actor rolls, and most static rolls.
 */
export class CustomRoll {
	/**
	 * Returns header data to be used for rendering
	 */
	static constructHeaderData(actorOrItem, label, { slotLevel=null }={}) {
		const { item, actor } = resolveActorOrItem(actorOrItem);
		const img = item ? item.img : ActorUtils.getImage(actor);

		/** @type {import("./renderer.js").HeaderDataProps}  */ 
		const results = {
			type: "header",
			img,
			label,
			slotLevel
		}

		return results;
	}
	
	/**
	 * Constructs multiroll data to be used for rendering
	 * @param {string} formula 
	 * @param {Object} options Roll options used to construct the multiroll.
	 * @param {number?} options.critThreshold minimum roll on the dice to cause a critical roll.
	 * @param {number?} options.numRolls number of rolls to perform
	 * @param {string?} options.title title to display above the roll
	 * @param {RollState?} options.rollState highest or lowest
	 * @param {string?} options.rollType metadata param for attack vs damage.
	 * @param {boolean?} options.elvenAccuracy whether the actor should apply elven accuracy 
	 * @param {DiceCollection?} dicePool Optional dicepool for 3d dice
	 */
	static constructMultiRoll(formula, options={}, dicePool = null) {
		const { critThreshold, title, rollState, rollType, elvenAccuracy } = options;

		let numRolls = options.numRolls || game.settings.get("betterrolls5e", "d20Mode");
		if (rollState && numRolls == 1) {
			numRolls = 2;
		}

		// Apply elven accuracy
		if (numRolls == 2 && elvenAccuracy && rollState !== "lowest") {
			numRolls = 3;
		}

		const entries = [];
		for (let i = 0; i < numRolls; i++) {
			const roll = new Roll(formula).roll();
			entries.push(Utils.processRoll(roll, critThreshold, [20]));
		}

		// Mark ignored rolls due to advantage/disadvantage
		if (rollState) {
			let rollTotals = entries.map(r => r.roll.total);
			let chosenResult = rollTotals[0];
			if (rollState == "highest") {
				chosenResult = rollTotals.sort(function(a, b){return a-b})[rollTotals.length-1];
			} else if (rollState == "lowest") {
				chosenResult = rollTotals.sort(function(a, b){return a-b})[0];
			}

			// Mark the non-results as ignored
			entries.filter(r => r.roll.total != chosenResult).forEach(r => r.ignored = true);
		}

		// Add to dicepool if given
		dicePool?.push(...entries.map(e => e.roll));

		/** @type {import("./renderer.js").MultiRollDataProps} */
		const results = {
			type: "multiroll",
			title,
			rollState,
			rollType,
			formula,
			entries,
			isCrit: entries.some(e => !e.ignored && e.isCrit)
		};

		return results;
	}
	
	/**
	 * 
	 * @param {*} args
	 * @returns {RollState} 
	 */
	static getRollState(args) {
		if (!args) {
			return null;
		}

		let adv = args.adv || 0;
		let disadv = args.disadv || 0;
		if (adv > 0 || disadv > 0) {
			if (adv > disadv) { return "highest"; }
			else if (adv < disadv) { return "lowest"; }
		} else { return null; }
	}
	
	// Returns an {adv, disadv} object when given an event
	static async eventToAdvantage(ev, itemType) {
		if (ev.shiftKey) {
			return {adv:1, disadv:0};
		} else if ((keyboard.isCtrl(ev))) {
			return {adv:0, disadv:1};
		} else if (game.settings.get("betterrolls5e", "queryAdvantageEnabled")) {
			// Don't show dialog for items that aren't tool or weapon.
			if (itemType != null && !itemType.match(/^(tool|weapon)$/)) {
				return {adv:0, disadv:0};
			}
			return new Promise(resolve => {
				new Dialog({
					title: i18n("br5e.querying.title"),
					buttons: {
						disadvantage: {
							label: i18n("br5e.querying.disadvantage"),
							callback: () => resolve({adv:0, disadv:1})
						},
						normal: {
							label: i18n("br5e.querying.normal"),
							callback: () => resolve({adv:0, disadv:0})
						},
						advantage: {
							label: i18n("br5e.querying.advantage"),
							callback: () => resolve({adv:1, disadv:0})
						}
					}
				}).render(true);
			});
		} else {
			return {adv:0, disadv:0};
		}
	}

	/**
	 * Internal method to perform a basic actor full roll of "something".
	 * It creates and display a chat message on completion.
	 * @param {*} actor 
	 * @param {string} label 
	 * @param {string} formula 
	 * @param {string} rollType 
	 * @param {object} params 
	 */
	static async fullRollActor(actor, label, formula, rollType, params) {
		const dicePool = new DiceCollection();
		
		// Entries to show for the render
		const entries = [
			CustomRoll.constructHeaderData(actor, label),
			CustomRoll.constructMultiRoll(formula, { 
				rollState: CustomRoll.getRollState(params), 
				critThreshold: params?.critThreshold,
				rollType
			}, dicePool)
		];

		const templates = entries.map(Renderer.renderModel);
		const content = await Renderer.renderCard(templates, { actor });
		
		// Output the rolls to chat
		await dicePool.flush();
		return ChatMessage.create(createChatData(actor, content));
	}
	
	/**
	 * Creates and displays a chat message to show a full skill roll
	 * @param {*} actor 
	 * @param {*} skill 
	 * @param {*} params 
	 */
	static async fullRollSkill(actor, skill, params={}) {
		const label = i18n(dnd5e.skills[skill]);
		const formula = ActorUtils.getSkillCheckRoll(actor, skill).formula;
		return CustomRoll.fullRollActor(actor, label, formula, "skill", params);
	}

	static async rollCheck(actor, ability, params) {
		return await CustomRoll.fullRollAttribute(actor, ability, "check", params);
	}
		
	static async rollSave(actor, ability, params) {
		return await CustomRoll.fullRollAttribute(actor, ability, "save", params);
	}
	
	/**
	* Creates and displays a chat message with the requested ability check or saving throw.
	* @param {Actor5e} actor		The actor object to reference for the roll.
	* @param {String} ability		The ability score to roll.
	* @param {String} rollType		String of either "check" or "save" 
	*/
	static async fullRollAttribute(actor, ability, rollType, params={}) {
		const label = dnd5e.abilities[ability];

		let titleString;
		let formula = "";
		if (rollType === "check") {
			formula = ActorUtils.getAbilityCheckRoll(actor, ability).formula;
			titleString = `${i18n(label)} ${i18n("br5e.chat.check")}`;
		} else if (rollType === "save") {
			formula = ActorUtils.getAbilitySaveRoll(actor, ability).formula;
			titleString = `${i18n(label)} ${i18n("br5e.chat.save")}`;
		}

		return CustomRoll.fullRollActor(actor, titleString, formula, rollType, params);
	}
	
	static newItemRoll(item, params, fields) {
		return new CustomItemRoll(item, params, fields);
	}
}

let defaultParams = {
	title: "",
	forceCrit: false,
	preset: false,
	properties: true,
	slotLevel: null,
	useCharge: {},
	useTemplate: false,
	event: null,
	adv: 0,
	disadv: 0,
};

/*
	CustomItemRoll(item,
	{
		forceCrit: false,
		quickRoll: false,
		properties: true,
		slotLevel: null,
		useCharge: {},
		useTemplate: false,
		adv: 0,
		disadv: 0,
	},
	[
		["attack", {triggersCrit: true}],
		["damage", {index:0, versatile:true}],
		["damage", {index:[1,2,4]}],
	]
	).toMessage();
*/

// A custom roll with data corresponding to an item on a character's sheet.
export class CustomItemRoll {
	constructor(item, params, fields) {
		this.item = item;
		this.actor = item.actor;
		this.itemFlags = item.data.flags;
		this.params = mergeObject(duplicate(defaultParams), params || {});	// General parameters for the roll as a whole.
		this.fields = fields;	// Where requested roll fields are stored, in the order they should be rendered.
		this.templates = [];	// Where finished templates are stored, in the order they should be rendered.
		
		/** @type {Array<import("./renderer.js").RenderModel>} */
		this.entries = [];		// Data results from fields, which get turned into templates
		
		this.rolled = false;
		this.isCrit = this.params.forceCrit || false;			// Defaults to false, becomes "true" when a valid attack or check first crits.
		this.rollState = null;
		this.params.event = this.params.event || event;

		this._updateConfig();
		this._setupRollState();
		this.dicePool = new DiceCollection();
	}
	
	/**
	 * Update config settings in the roll.
	 * TODO: This needs to be moved to an actual settings ES module.
	 * @private
	 */
	_updateConfig() {
		const getBRSetting = (setting) => game.settings.get("betterrolls5e", setting);

		this.config = {
			playRollSounds: getBRSetting("playRollSounds"),
			hasMaestroSound: ItemUtils.hasMaestroSound(this.item),
			damageRollPlacement: getBRSetting("damageRollPlacement"),
			rollTitlePlacement: getBRSetting("rollTitlePlacement"),
			damageTitlePlacement: getBRSetting("damageTitlePlacement"),
			damageContextPlacement: getBRSetting("damageContextPlacement"),
			contextReplacesTitle: getBRSetting("contextReplacesTitle"),
			contextReplacesDamage: getBRSetting("contextReplacesDamage"),
			critString: getBRSetting("critString"),
			critBehavior: getBRSetting("critBehavior"),
			quickDefaultDescriptionEnabled: getBRSetting("quickDefaultDescriptionEnabled"),
			altSecondaryEnabled: getBRSetting("altSecondaryEnabled"),
			d20Mode: getBRSetting("d20Mode"),
			hideDC: getBRSetting("hideDC")
		};
	}
	
	/**
	 * Initialization function to detect advantage/disadvantage from events and setup the roll state.
	 * @private
	 */
	_setupRollState() {
		const modifiers = Utils.getEventRollModifiers(this.params.event);
		this.params = mergeObject(this.params, modifiers);
		
		this.rollState = null;
		const { adv, disadv } = this.params;
		if (adv > 0 || disadv > 0) {
			if (adv > disadv) { this.rollState = "highest"; }
			else if (adv < disadv) { this.rollState = "lowest"; }
		}
	}
	
	async roll() {
		if (this.rolled) {
			console.log("Already rolled!", this);
			return;
		}

		const { params, item } = this;
		const itemData = item.data.data;
		const actor = item.actor;
		
		await ItemUtils.ensureFlags(item);
		
		Hooks.call("preRollItemBetterRolls", this);
		
		if (Number.isInteger(params.preset)) {
			this.updateForPreset();
		}

		if (this.params.useCharge.resource) {
			const consume = itemData.consume;
			if ( consume?.type === "ammo" ) {
				this.ammo = this.actor.items.get(consume.target);
			}
		}
		
		if (!params.slotLevel) {
			if (item.data.type === "spell") {
				params.slotLevel = await this.configureSpell();
				if (params.slotLevel === "error") { return "error"; }
			}
		}

		// Convert all requested fields into templates to be entered into the chat message.
		this.templates = await this._renderTemplates();
		
		// Item Footer Properties
		this.properties = (params.properties) ? this._listProperties() : null;
		
		// Check to consume charges. Prevents the roll if charges are required and none are left.
		let chargeCheck = await this.consumeCharge();
		if (chargeCheck === "error") { return "error"; }
		
		if (params.useTemplate && (item.data.type == "feat" || item.data.data.level == 0)) {
			this.placeTemplate();
		}
		
		this.rolled = true;
		
		await Hooks.callAll("rollItemBetterRolls", this);
		await new Promise(r => setTimeout(r, 25));
		
		// Render final template
		const { isCrit, properties } = this;
		this.content = await Renderer.renderCard(this.templates, { 
			item, actor, isCrit, properties
		});
		
		if (chargeCheck === "destroy") { await actor.deleteOwnedItem(item.id); }

		return this.content;
	}

	/**
	 * Function that immediately processes and renders a given field
	 * @param {*} field 
	 */
	async fieldToTemplate(field) {
		let item = this.item;
		let fieldType = field[0].toLowerCase();
		let fieldArgs = field.slice();
		fieldArgs.splice(0,1);
		switch (fieldType) {
			case 'attack':
				// {adv, disadv, bonus, triggersCrit, critThreshold}
				this.entries.push(this._rollAttack(fieldArgs[0]));
				break;
			case 'toolcheck':
			case 'tool':
			case 'check':
				this.entries.push(this._rollTool(fieldArgs[0]));
				break;
			case 'damage':
				// {damageIndex: 0, forceVersatile: false, forceCrit: false}
				let index, versatile, crit, context;
				let damagesToPush = [];
				if (typeof fieldArgs[0] === "object") {
					index = fieldArgs[0].index;
					versatile = fieldArgs[0].versatile;
					crit = fieldArgs[0].crit;
					context = fieldArgs[0].context;
				}
				let oldIndex = index;
				if (index === "all") {
					let newIndex = [];
					for (let i=0;i<this.item.data.data.damage.parts.length;i++) {
						newIndex.push(i);
					}
					index = newIndex;
				} else if (Number.isInteger(index)) {
					let newIndex = [index];
					index = newIndex;
				}
				for (let i=0;i<index.length;i++) {
					this.entries.push({
						type: "raw",
						content: await this.rollDamage({
							damageIndex: index[i] || 0,
							// versatile damage will only replace the first damage formula in an "all" damage request
							forceVersatile: (i == 0 || oldIndex !== "all") ? versatile : false,
							forceCrit: crit,
							customContext: context
						})
					});
				}
				if (this.ammo) {
					this.item = this.ammo;
					delete this.ammo;
					await this.fieldToTemplate(['damage', {index: 'all', versatile: false, crit, context: `[${this.item.name}]`}]);
					this.item = item;
				}
				break;
			case 'savedc':
				// {customAbl: null, customDC: null}
				let abl, dc;
				if (fieldArgs[0]) {
					abl = fieldArgs[0].abl;
					dc = fieldArgs[0].dc;
				}
				this.entries.push({ type: "raw", content: await this.saveRollButton({customAbl:abl, customDC:dc})});
				break;
			case 'other':
				if (item.data.data.formula) { 
					this.entries.push({ type: "raw", content: await this.rollOther() });
				}
				break;
			case 'custom':
				this.entries.push(this._rollCustom(fieldArgs[0]));
				break;
			case 'description':
			case 'desc':
				// Display info from Components module
				let componentField = "";
				if (game.modules.get("components5e") && game.modules.get("components5e").active) {
					componentField = window.ComponentsModule.getComponentHtml(item, 20);
				}
				fieldArgs[0] = {text: componentField + item.data.data.description.value};
			case 'text':
				if (fieldArgs[0].text) {
					this.entries.push({
						type: "description",
						content: fieldArgs[0].text
					});
				}
				break;
			case 'flavor':
				this.entries.push({
					type: "description",
					isFlavor: true,
					content: fieldArgs[0]?.text ?? this.item.data.data.chatFlavor
				});
				break;
			case 'crit':
				this.entries.push({type: "raw", content: await this.rollCritExtra()});
				break;
		}
		return true;
	}

	async _renderTemplates() {
		this.entries.push(this._rollHeader());
		for (let i=0;i<this.fields.length;i++) {
			await this.fieldToTemplate(this.fields[i]);
		}

		if (this.isCrit && this.hasDamage && this.item.data.flags.betterRolls5e?.critDamage?.value) {
			await this.fieldToTemplate(["crit"]);
		}

		// todo: consider resetting the template list?
		for (const model of this.entries) {
			this.templates.push(Renderer.renderModel(model));
		}

		return this.templates;
	}
	
	/**
	 * Creates and sends a chat message. If not already rolled, roll() is called first.
	 */
	async toMessage() {
		if (!this.rolled) {
			await this.roll();
		}

		if (this.content === "error") return;

		const hasMaestroSound = this.config.hasMaestroSound;
		this.chatData = createChatData(this.actor, this.content, { hasMaestroSound });
		await Hooks.callAll("messageBetterRolls", this, this.chatData);
		await this.dicePool.flush();
		return await ChatMessage.create(this.chatData);
	}
	
	/**
	 * Updates the rollRequests based on the br5e flags.
	 */
	updateForPreset() {
		let item = this.item,
			itemData = item.data.data,
			flags = item.data.flags,
			brFlags = flags.betterRolls5e,
			preset = this.params.preset,
			properties = false,
			useCharge = {},
			useTemplate = false,
			fields = [],
			val = (preset === 1) ? "altValue" : "value";
			
		
		if (brFlags) {
			// Assume new action of the button based on which fields are enabled for Quick Rolls
			function flagIsTrue(flag) {
				return (brFlags[flag] && (brFlags[flag][val] == true));
			}

			function getFlag(flag) {
				return (brFlags[flag] ? (brFlags[flag][val]) : null);
			}
			
			if (flagIsTrue("quickFlavor") && itemData.chatFlavor) { fields.push(["flavor"]); }
			if (flagIsTrue("quickDesc")) { fields.push(["desc"]); }
			if (flagIsTrue("quickAttack") && isAttack(item)) { fields.push(["attack"]); }
			if (flagIsTrue("quickCheck") && isCheck(item)) { fields.push(["check"]); }
			if (flagIsTrue("quickSave") && isSave(item)) { fields.push(["savedc"]); }
			
			if (brFlags.quickDamage && (brFlags.quickDamage[val].length > 0)) {
				for (let i = 0; i < brFlags.quickDamage[val].length; i++) {
					let isVersatile = (i == 0) && flagIsTrue("quickVersatile");
					if (brFlags.quickDamage[val][i]) { fields.push(["damage", {index:i, versatile:isVersatile}]); }
				}
			}


			if (flagIsTrue("quickOther")) { fields.push(["other"]); }
			if (flagIsTrue("quickProperties")) { properties = true; }

			if (brFlags.quickCharges) {
				useCharge = duplicate(getFlag("quickCharges"));
			}
			if (flagIsTrue("quickTemplate")) { useTemplate = true; }
		} else { 
			//console.log("Request made to Quick Roll item without flags!");
			fields.push(["desc"]);
			properties = true;
		}
		
		this.params = mergeObject(this.params, {
			properties,
			useCharge,
			useTemplate,
		});

		console.log(this.params);
		
		this.fields = fields.concat((this.fields || []).slice());
	}
	
	/**
	 * A function for returning the properties of an item, which can then be printed as the footer of a chat card.
	 * @private
	 */
	_listProperties() {
		const item = this.item;
		const data = item.data.data;
		let properties = [];
		
		const range = ItemUtils.getRange(item);
		const target = ItemUtils.getTarget(item);
		const activation = ItemUtils.getActivationData(item)
		const duration = ItemUtils.getDuration(item);

		switch(item.data.type) {
			case "weapon":
				properties = [
					dnd5e.weaponTypes[data.weaponType],
					range,
					target,
					data.proficient ? "" : i18n("Not Proficient"),
					data.weight ? data.weight + " " + i18n("lbs.") : null
				];
				for (const prop in data.properties) {
					if (data.properties[prop] === true) {
						properties.push(dnd5e.weaponProperties[prop]);
					}
				}
				break;
			case "spell":
				// Spell attack labels
				data.damageLabel = data.actionType === "heal" ? i18n("br5e.chat.healing") : i18n("br5e.chat.damage");
				data.isAttack = data.actionType === "attack";

				properties = [
					dnd5e.spellSchools[data.school],
					dnd5e.spellLevels[data.level],
					data.components.ritual ? i18n("Ritual") : null,
					activation,
					duration,
					data.components.concentration ? i18n("Concentration") : null,
					ItemUtils.getSpellComponents(item),
					range,
					target
				];
				break;
			case "feat":
				properties = [
					data.requirements,
					activation,
					duration,
					range,
					target,
				];
				break;
			case "consumable":
				properties = [
					data.weight ? data.weight + " " + i18n("lbs.") : null,
					activation,
					duration,
					range,
					target,
				];
				break;
			case "equipment":
				properties = [
					dnd5e.equipmentTypes[data.armor.type],
					data.equipped ? i18n("Equipped") : null,
					data.armor.value ? data.armor.value + " " + i18n("AC") : null,
					data.stealth ? i18n("Stealth Disadv.") : null,
					data.weight ? data.weight + " lbs." : null,
				];
				break;
			case "tool":
				properties = [
					dnd5e.proficiencyLevels[data.proficient],
					data.ability ? dnd5e.abilities[data.ability] : null,
					data.weight ? data.weight + " lbs." : null,
				];
				break;
			case "loot":
				properties = [data.weight ? item.data.totalWeight + " lbs." : null]
				break;
		}
		let output = properties.filter(p => (p) && (p.length !== 0) && (p !== " "));
		return output;
	}

	_rollHeader() {
		let printedSlotLevel = null;
		if (this.item && this.item.data.type === "spell" && slotLevel != this.item.data.data.level) {
			printedSlotLevel = dnd5e.spellLevels[slotLevel];
		}

		return CustomRoll.constructHeaderData(this.item, this.item.name, { 
			slotLevel: printedSlotLevel
		});
	}

	/**
	 * Rolls an attack roll for the item.
	 * @param {Object} props				Object containing all named parameters
	 * @param {Number} props.adv			1 for advantage
	 * @param {Number} props.disadv			1 for disadvantage
	 * @param {String} props.bonus			Additional situational bonus
	 * @param {Boolean} props.triggersCrit	Whether a crit for this triggers future damage rolls to be critical
	 * @param {Number} props.critThreshold	Minimum roll for a d20 is considered a crit
	 * @private
	 */
	_rollAttack(props) {
		let args = mergeObject({
			adv: this.params.adv,
			disadv: this.params.disadv,
			bonus: null,
			triggersCrit: true,
			critThreshold: null
		}, props || {});

		let itm = this.item;
		const itemData = itm.data.data;
		const title = (this.config.rollTitlePlacement !== "0") ? i18n("br5e.chat.attack") : null;
		
		this.hasAttack = true;
		
		// Add critical threshold
		let critThreshold = 20;
		let characterCrit = 20;
		try { 
			characterCrit = Number(getProperty(itm, "actor.data.flags.dnd5e.weaponCriticalThreshold")) || 20;
		} catch(error) { 
			characterCrit = itm.actor.data.flags.dnd5e.weaponCriticalThreshold || 20;
		}
		
		let itemCrit = Number(getProperty(itm, "data.flags.betterRolls5e.critRange.value")) || 20;
		//	console.log(critThreshold, characterCrit, itemCrit);
		
		if (args.critThreshold) {
			// If a specific critThreshold is set, use that
			critThreshold = args.critThreshold;
		} else {
			// Otherwise, determine it from character & item data
			if (['mwak', 'rwak'].includes(itemData.actionType)) {
				critThreshold = Math.min(critThreshold, characterCrit, itemCrit);
			} else {
				critThreshold = Math.min(critThreshold, itemCrit);
			}
		}

		// Get ammo bonus and add to title if relevant
		const ammoBonus = this.ammo?.data.data.attackBonus;
		if (ammoBonus) {
			title += ` [${ammo.name}]`;
		}
		
		// Perform the final construction and begin rolling
		const abilityMod = ItemUtils.getAbilityMod(itm);
		const rollState = CustomRoll.getRollState(args);
		const formula = ItemUtils.getAttackRoll(itm, {
			abilityMod,
			ammoBonus,
			bonus: args.bonus
		}).formula;
		const multiRollData = CustomRoll.constructMultiRoll(formula, {
			rollState,
			title,
			critThreshold,
			elvenAccuracy: ActorUtils.testElvenAccuracy(itm.actor, abilityMod)
		}, this.dicePool);
		
		// If this can trigger a crit and it also crit, flag it as a crit.
		// Currently, crits cannot be un-set.
		if (args.triggersCrit && multiRollData.isCrit) {
			this.isCrit = true;
		}

		return multiRollData;
	}

	/**
	 * 
	 * @param {*} preArgs 
	 * @private
	 */
	async _rollTool(preArgs) {
		let args = mergeObject({adv: 0, disadv: 0, bonus: null, triggersCrit: true, critThreshold: null, rollState: this.rollState}, preArgs || {});
		let itm = this.item;
		const title = args.title || ((this.config.rollTitlePlacement != "0") ? i18n("br5e.chat.check") : null);
			
		// Begin rolling the multiroll, and return the result
		const rollState = CustomRoll.getRollState(args);
		const formula = ItemUtils.getToolRoll(itm, args.bonus).formula;
		const multiRollData = CustomRoll.constructMultiRoll(formula, {
			rollState,
			title,
			critThreshold: args.critThreshold,
			elvenAccuracy: ActorUtils.testElvenAccuracy(itm.actor, abl)
		}, this.dicePool);
		
		this.isCrit = args.triggersCrit || multiRollData.isCrit;

		return multiRollData;
	}

	/**
	 * 
	 * @param {*} args
	 * @private 
	 */
	_rollCustom(args) {
		/* args:
				title			title of the roll
				formula			the roll formula
				rolls			number of rolls
				rollState		"adv" or "disadv" converts to "highest" or "lowest"
		*/
		let rollStates = {
			null: null,
			"adv": "highest",
			"disadv": "lowest"
		};
		
		const { rolls, formula, rollState } = args;
		let rollData = ItemUtils.getRollData(this.item);
		const resolvedFormula = new Roll(formula, rollData).formula;
		this.entries.push(CustomRoll.constructMultiRoll(resolvedFormula || "1d20", {
			numRolls: rolls || 1,
			rollState: rollStates[rollState],
			rollType: "custom",
		}, this.dicePool));
	}
	
	async damageTemplate ({baseRoll, critRoll, labels, type}) {
		let baseTooltip = await baseRoll.getTooltip();
		
		if (baseRoll.terms.length === 0) return;
		
		const tooltips = [baseTooltip];
		if (critRoll) {
			tooltips.push(await critRoll.getTooltip());
		}
		
		let chatData = {
			tooltips,
			base: Utils.processRoll(baseRoll),
			crit: Utils.processRoll(critRoll),
			crittext: this.config.critString,
			damagetop: labels[1],
			damagemid: labels[2],
			damagebottom: labels[3],
			formula: baseRoll.formula,
			damageType:type,
			maxRoll: await new Roll(baseRoll.formula).evaluate({maximize:true}).total,
			maxCrit: critRoll ? await new Roll(critRoll.formula).evaluate({maximize:true}).total : null
		};
		
		let html = await renderTemplate("modules/betterrolls5e/templates/red-damageroll.html", chatData);
		let output = {
			type: "damage",
			html,
			data: chatData
		}

		return output;
	}
	
	async rollDamage({damageIndex = 0, forceVersatile = false, forceCrit = false, bonus = 0, customContext = null}) {
		let itm = this.item;
		let itemData = itm.data.data,
			flags = itm.data.flags.betterRolls5e,
			damageFormula,
			damageType = itemData.damage.parts[damageIndex][1],
			isVersatile = false,
			slotLevel = this.params.slotLevel;
		
		const rollData = ItemUtils.getRollData(itm, { slotLevel });

		// Makes the custom roll flagged as having a damage roll.
		this.hasDamage = true;
		
		// Change first damage formula if versatile
		if (((this.params.versatile && damageIndex === 0) || forceVersatile) && itemData.damage.versatile.length > 0) {
			damageFormula = itemData.damage.versatile;
			isVersatile = true;
		} else {
			damageFormula = itemData.damage.parts[damageIndex][0];
		}

		// Require a formula to continue
		if (!damageFormula) { 
			return null;
		}
		
		const parts = [];
		const dtype = CONFIG.betterRolls5e.combinedDamageTypes[damageType];
		
		// Prepare roll label
		let titlePlacement = this.config.damageTitlePlacement.toString(),
			damagePlacement = this.config.damageRollPlacement.toString(),
			contextPlacement = this.config.damageContextPlacement.toString(),
			replaceTitle = this.config.contextReplacesTitle,
			replaceDamage = this.config.contextReplacesDamage,
			labels = {
				"1": [],
				"2": [],
				"3": []
			};
		
		let titleString = "",
			damageString = [],
			contextString = customContext || (flags.quickDamage.context && flags.quickDamage.context[damageIndex]);
		
		// Show "Healing" prefix only if it's not inherently a heal action
		if (dnd5e.healingTypes[damageType]) { titleString = ""; }
		// Show "Damage" prefix if it's a damage roll
		else if (dnd5e.damageTypes[damageType]) { titleString += i18n("br5e.chat.damage"); }
		
		// Title
		let pushedTitle = false;
		if (titlePlacement !== "0" && titleString && !(replaceTitle && contextString && titlePlacement == contextPlacement)) {
			labels[titlePlacement].push(titleString);
			pushedTitle = true;
		}
		
		// Context
		if (contextString) {
			if (contextPlacement === titlePlacement && pushedTitle) {
				labels[contextPlacement][0] = (labels[contextPlacement][0] ? labels[contextPlacement][0] + " " : "") + "(" + contextString + ")";
			} else {
				labels[contextPlacement].push(contextString);
			}
		}
		
		// Damage type
		if (dtype) { 
			damageString.push(dtype);
		}
		if (isVersatile) { 
			damageString.push("(" + dnd5e.weaponProperties.ver + ")");
		}

		damageString = damageString.join(" ");
		if (damagePlacement !== "0" && damageString.length > 0 && !(replaceDamage && contextString && damagePlacement == contextPlacement)) {
			labels[damagePlacement].push(damageString);
		}
		
		for (let p in labels) {
			labels[p] = labels[p].join(" - ");
		};

		// Scale damage if its the first entry
		if (damageIndex === 0) {
			damageFormula = this.scaleDamage(damageIndex, isVersatile, rollData) || damageFormula;
		}
		
		if (damageIndex == 0 && rollData.bonuses && isAttack(itm)) {
			let actionType = `${itemData.actionType}`;
			if (rollData.bonuses[actionType].damage) {
				parts.unshift(rollData.bonuses[actionType].damage);
			}
		}
		
		const rollFormula = [damageFormula, ...parts].join("+");
		const baseRoll = await new Roll(rollFormula, rollData).roll();
		this.dicePool.push(baseRoll);

		let critRoll = null;
		const critBehavior = this.params.critBehavior ? this.params.critBehavior : this.config.critBehavior;

		if ((forceCrit == true || (this.isCrit && forceCrit !== "never")) && critBehavior !== "0") {
			critRoll = ItemUtils.getCritRoll(this.item, baseRoll.formula, baseRoll.total, critBehavior);
			this.dicePool.push(critRoll);
		}
		
		let damageRoll = await this.damageTemplate({baseRoll: baseRoll, critRoll: critRoll, labels: labels, type:damageType});

		return damageRoll;
	}
	
	scaleDamage(damageIndex, versatile, rollData) {
		let item = this.item;
		let itemData = item.data.data;
		let actorData = item.actor.data.data;
		let spellLevel = this.params.slotLevel;
		
		// Scaling for cantrip damage by level. Affects only the first damage roll of the spell.
		if (item.data.type === "spell" && itemData.scaling.mode === "cantrip") {
			let parts = itemData.damage.parts.map(d => d[0]);
			let level = item.actor.data.type === "character" ? ActorUtils.getCharacterLevel(item.actor) : actorData.details.cr;
			let scale = itemData.scaling.formula;
			let formula = parts[damageIndex];
			const add = Math.floor((level + 1) / 6);
			if ( add === 0 ) {}
			else {
				formula = item._scaleDamage([formula], scale || formula, add, rollData);
				if (versatile) { formula = item._scaleDamage([itemData.damage.versatile], itemData.damage.versatile, add, rollData); }
			}
			return formula;
		}
		
		// Scaling for spell damage by spell slot used. Affects only the first damage roll of the spell.
		if (item.data.type === "spell" && itemData.scaling.mode === "level" && spellLevel) {
			let parts = itemData.damage.parts.map(d => d[0]);
			let level = itemData.level;
			let scale = itemData.scaling.formula;
			let formula = parts[damageIndex];
			const add = Math.floor(spellLevel - level);
			if (add > 0) {
				formula = item._scaleDamage([formula], scale || formula, add, rollData);
				if (versatile) { formula = item._scaleDamage([itemData.damage.versatile], itemData.damage.versatile, add, rollData); }
			}
			
			return formula;
		}
		
		return null;
	}

	async rollCritExtra(index) {
		let damageIndex = (index ? toString(index) : null) || 
			this.item.data.flags.betterRolls5e?.critDamage?.value || 
			"";
		if (damageIndex) {
			return await this.rollDamage({damageIndex:Number(damageIndex), forceCrit:"never"});
		}
	}
	
	/*
	Rolls the Other Formula field. Is subject to crits.
	*/
	async rollOther() {
		const item = this.item;
		const isCrit = this.isCrit;
		const formula = item.data.data.formula;
		const flags = item.data.flags.betterRolls5e;

		const rollData = ActorUtils.getRollData(item.actor);
		
		let titlePlacement = this.config.damageTitlePlacement,
			contextPlacement = this.config.damageContextPlacement,
			replaceTitle = this.config.contextReplacesTitle,
			labels = {
				"1": [],
				"2": [],
				"3": []
			};
			
		// Title
		let titleString = i18n("br5e.chat.other"),
			contextString = flags.quickOther.context;
		
		let pushedTitle = false;
		if (titlePlacement !== "0" && !(replaceTitle && contextString && titlePlacement == contextPlacement)) {
			labels[titlePlacement].push(titleString);
			pushedTitle = true;
		}
		
		// Context
		if (contextString) {
			if (contextPlacement === titlePlacement && pushedTitle) {
				labels[contextPlacement][0] = (labels[contextPlacement][0] ? labels[contextPlacement][0] + " " : "") + "(" + contextString + ")";
			} else {
				labels[contextPlacement].push(contextString);
			}
		}
		
		const baseRoll = await new Roll(formula, rollData).roll();
		this.dicePool.push(baseRoll);
		
		let critRoll = null;
		const critBehavior = this.params.critBehavior ? this.params.critBehavior : this.config.critBehavior;
		
		if (isCrit && critBehavior !== "0") {
			critRoll = ItemUtils.getCritRoll(this.item, baseRoll.formula, baseRoll.total, critBehavior);
			this.dicePool.push(critRoll);
		}

		return this.damageTemplate({baseRoll: baseRoll, critRoll: critRoll, labels: labels});
	}
	
	/* 	Generates the html for a save button to be inserted into a chat message. Players can click this button to perform a roll through their controlled token.
	*/
	async saveRollButton({customAbl = null, customDC = null}) {
		let item = this.item;
		let actor = item.actor;
		let saveData = getSave(item);
		if (customAbl) { saveData.ability = saveArgs.customAbl; }
		if (customDC) { saveData.dc = saveArgs.customDC; }
		
		let hideDC = (this.config.hideDC == "2" || (this.config.hideDC == "1" && actor.data.type == "npc")); // Determine whether the DC should be hidden

		let divHTML = `<span ${hideDC ? 'class="hideSave"' : null} style="display:inline;line-height:inherit;">${saveData.dc}</span>`;
		
		let saveLabel = `${i18n("br5e.buttons.saveDC")} ` + divHTML + ` ${dnd5e.abilities[saveData.ability]}`;
		let button = {
			type: "saveDC",
			html: await renderTemplate("modules/betterrolls5e/templates/red-save-button.html", {data: saveData, saveLabel: saveLabel})
		}
		
		return button;
	}
	
	async configureSpell() {
		let item = this.item;
		let actor = item.actor;
		let lvl = null;
		let consume = false;
		let placeTemplate = false;
		let isPact = false;
		
		// Only run the dialog if the spell is not a cantrip
		if (item.data.data.level > 0) {
			try {
				console.log("level > 0")
				window.PH = {};
				window.PH.actor = actor;
				window.PH.item = item;
				const spellFormData = await game.dnd5e.applications.AbilityUseDialog.create(item);
				lvl = spellFormData.get("level");
				consume = Boolean(spellFormData.get("consumeSlot"));
				placeTemplate = Boolean(spellFormData.get("placeTemplate"));
				// console.log(lvl, consume, placeTemplate);
			}
			catch(error) { return "error"; }
		}
		
		if (lvl == "pact") {
			isPact = true;
			lvl = getProperty(actor, `data.data.spells.pact.level`) || lvl;
		}
		
		if ( lvl !== item.data.data.level ) {
			item = item.constructor.createOwned(mergeObject(duplicate(item.data), {"data.level": lvl}, {inplace: false}), actor);
		}
		
		// Update Actor data
		if ( consume && (lvl !== 0) ) {
			let spellSlot = isPact ? "pact" : "spell"+lvl;
			const slots = parseInt(actor.data.data.spells[spellSlot].value);
	  if ( slots === 0 || Number.isNaN(slots) ) {
				ui.notifications.error(game.i18n.localize("DND5E.SpellCastNoSlots"));
				return "error";
			}
			await actor.update({
				[`data.spells.${spellSlot}.value`]: Math.max(parseInt(actor.data.data.spells[spellSlot].value) - 1, 0)
			});
		}
		
		if (placeTemplate) {
			this.placeTemplate();
		}
		
		return lvl;
	}
	
	// Places a template if the item has an area of effect
	placeTemplate() {
		let item = this.item;
		if (item.hasAreaTarget) {
			const template = game.dnd5e.canvas.AbilityTemplate.fromItem(item);
			if ( template ) template.drawPreview(event);
			if (item.actor && item.actor.sheet) {
				if (item.sheet.rendered) item.sheet.minimize();
				if (item.actor.sheet.rendered) item.actor.sheet.minimize();
			}
		}
	}
	
	// Consumes charges & resources assigned on an item.
	async consumeCharge() {
		let item = this.item,
			itemData = item.data.data;
		
		const hasUses = !!(itemData.uses.value || itemData.uses.max || itemData.uses.per); // Actual check to see if uses exist on the item, even if params.useCharge.use == true
		const hasResource = !!(itemData.consume?.target); // Actual check to see if a resource is entered on the item, even if params.useCharge.resource == true

		const request = this.params.useCharge; // Has bools for quantity, use, resource, and charge
		const recharge = itemData.recharge || {};
		const uses = itemData.uses || {};
		const autoDestroy = uses.autoDestroy;
		const current = uses.value || 0;
		const remaining = request.use ? Math.max(current - 1, 0) : current;
		const q = itemData.quantity;
		const updates = {};
		let output = "success";

		// Check for consuming uses, but not quantity
		if (hasUses && request.use && !request.quantity) {
			if (!current) { ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", {name: item.name})); return "error"; }
		}

		// Check for consuming quantity, but not uses
		if (request.quantity && !request.use) {
			if (!q) { ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", {name: item.name})); return "error"; }
		}

		// Check for consuming quantity and uses
		if (hasUses && request.use && request.quantity) {
			if (!current && q <= 1) { ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", {name: item.name})); return "error"; }
		}

		// Check for consuming charge ("Action Recharge")
		if (request.charge) {
			if (!recharge.charged) { ui.notifications.warn(game.i18n.format("DND5E.ItemNoUses", {name: item.name})); return "error"; }
		}

		// Check for consuming resource.
		// Note that _handleResourceConsumption() will actually consume the resource as well as perform the check, hence why it must be performed last.
		if (hasResource && request.resource) {
			const allowed = await item._handleResourceConsumption({isCard: true, isAttack: true});
			if (allowed === false) { return "error"; }
		}

		// Handle uses, but not quantity
		if (hasUses && request.use && !request.quantity) {
			updates["data.uses.value"] = remaining;
		}
		
		// Handle quantity, but not uses
		else if (request.quantity && !request.use) {
			if (q <= 1 && autoDestroy) {
				output = "destroy";
			}
			updates["data.quantity"] = q - 1;
		}

		// Handle quantity and uses
		else if (hasUses && request.use && request.quantity) {
			let remainingU = remaining;
			let remainingQ = q;
			console.log(remainingQ, remainingU);
			if (remainingU < 1) {
				remainingQ -= 1;
				ui.notifications.warn(game.i18n.format("br5e.error.autoDestroy", {name: item.name}));
				if (remainingQ >= 1) {
					remainingU = itemData.uses.max || 0;
				} else { remainingU = 0; }
				if (remainingQ < 1 && autoDestroy) { output = "destroy"; }
			}

			updates["data.quantity"] = Math.max(remainingQ,0);
			updates["data.uses.value"] = Math.max(remainingU,0);
		}

		// Handle charge ("Action Recharge")
		if (request.charge) {
			updates["data.recharge.charged"] = false;
		}

		item.update(updates);

		return output;
	}
}