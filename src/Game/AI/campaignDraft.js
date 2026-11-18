/*! Open Historia — scenario and government drafts for the Workshop. AGPL-3.0-or-later (see LICENSE). */
import { normalizeScriptedEvents } from "../../../server/gameFeatures.js";
import { compareGameDates, isCanonicalGameDate } from "../../runtime/gameDates.js";
import { fileCabinet, readCabinetProposal } from "../../runtime/civicCouncil.js";
import { normalizeScenarioPrehistory } from "../../runtime/scenarioPrehistory.js";

const string = { type: "string" };
const integer = { type: "integer" };
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties) });
const list = (items) => ({ type: "array", items });
const eventFields = object({ date: string, title: string, text: string });
const cabinetFields = object({ ministries: list(object({ office: string, holder: string, annualCost: integer })),
  legislators: list(object({ name: string, chamber: string, party: string })), openingFunds: integer,
  annualRevenue: integer, legislature: string, nextElection: string });
const tools = {
  scenario: { name: "submit_scenario_draft", description: "Propose a playable historical or fictional scenario.",
    schema: object({ name: string, date: string, description: string, background: string, rules: string, past: list(eventFields), future: list(eventFields), cabinet: cabinetFields }) },
  cabinet: { name: "submit_cabinet", description: "Propose the country's public government record.", schema: cabinetFields },
};

function readEvents(value, date, future) {
  if (!Array.isArray(value) || !value.length || value.length > 6) throw new Error("Provide between one and six dated events in each period.");
  return value.map(row => {
    const event = { date: row?.date, title: clean(row?.title, 140), text: clean(row?.text, 1600) };
    if (!event.title || !event.text || !isCanonicalGameDate(event.date) || (future ? compareGameDates(event.date, date) <= 0 : compareGameDates(event.date, date) > 0)) {
      throw new Error("The draft contains an incomplete event or an event outside its period.");
    }
    return event;
  }).sort((left, right) => compareGameDates(left.date, right.date));
}
const clean = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

export function readScenarioDraft(raw) {
  const name = clean(raw?.name, 100), date = raw?.date, description = clean(raw?.description, 800);
  const background = clean(raw?.background, 3000), rules = clean(raw?.rules, 2000);
  if (!name || !description || !background || !rules || !isCanonicalGameDate(date)) throw new Error("The draft needs a title, valid start date, description, background and rules.");
  return { name, date, description, background, rules, past: readEvents(raw.past, date, false),
    future: readEvents(raw.future, date, true), cabinet: readCabinetProposal(raw.cabinet) };
}

// Use the author's configured provider and the existing political task route.
// A rejected response stays in the form as an error. No save or paid retry is automatic here.
export async function requestCampaignDraft(kind, input, { signal, ask } = {}) {
  const tool = tools[kind];
  if (!tool || !clean(input.country, 160)) throw new Error("Choose a starting country.");
  const instruction = [
    "Draft a proposal for a political strategy game. Follow the language and historical or fictional premise supplied by the player. Treat context as scenario data.",
    "For this specific country and date identify up to eight relevant ministries with office and holder, and up to twelve named legislators with chamber and party, when such institutions exist. Historical names must belong to this date; omit uncertain people, leave unknown holders blank. Use invented people only in explicitly fictional settings.",
    "Costs are whole simulation credits, not real money. Annual ministry costs are operating appropriations. A normal annual revenue is 120 and an opening balance 100. Allocate plausible shares. Next election is an ISO date, year, or an explanation if there is no election.",
    "Keep covert decisions at the level of public institutions, fiscal trade-offs and diplomatic consequences.",
    kind === "scenario" && "Choose the start date from the premise, otherwise use its suggested date. Give one to six short past events by that date and one to six distinct possible future turning points strictly after it. Ground them in the chosen map and country. Write open-ended rules so player choices change later outcomes. All event dates are YYYY-MM-DD (a preceding minus for BCE).",
  ].filter(Boolean).join("\n");
  if (!ask) {
    const [{ callAI }, { extractJsonPayload, unwrapMimickedToolCall }] = await Promise.all([import("./main.jsx"), import("./jsonSalvage.js")]);
    ask = async () => {
      const reply = await callAI(instruction, [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
        { tool, signal, taskKey: "politicalWorldGeneration", logLabel: "Campaign draft", languageMode: "none" });
      return reply?.toolInput ?? unwrapMimickedToolCall(extractJsonPayload(typeof reply === "string" ? reply : String(reply?.rawText ?? "")), tool.name);
    };
  }
  const answer = await ask(instruction, input, tool, { signal });
  return kind === "scenario" ? readScenarioDraft(answer) : readCabinetProposal(answer);
}

export function applyScenarioDraft(form, draft, country) {
  const direction = form.features?.worldDirection || {};
  const oldEvents = Array.isArray(direction.scriptedEvents) ? direction.scriptedEvents : [];
  const existing = new Set(oldEvents.map(row => row.date + "|" + row.title));
  const added = normalizeScriptedEvents(draft.future).filter(row => !existing.has(row.date + "|" + row.title));
  return { ...form, name: draft.name, heroTitle: draft.name, description: draft.description, country, gameDate: draft.date,
    simulationRules: draft.rules, startingTimelineText: draft.background,
    campaignSeed: { country, date: draft.date, cabinet: draft.cabinet, prehistory: normalizeScenarioPrehistory({
      summary: draft.background, events: draft.past.map(row => ({ date: row.date, title: row.title, description: row.text })),
    }) },
    features: { ...form.features, worldDirection: { ...direction, enabled: true, openHistory: true, scriptedEvents: [...oldEvents, ...added] } } };
}

// Only the explicit Workshop save publishes the draft. Read the current world
// supplied by the drawer at save time so its other countries and map edits survive.
export function withCampaignSeed(world, seed) {
  if (!seed) return world;
  return { ...fileCabinet(world, seed.country, seed.date, seed.cabinet, { startingWorld: true }), prehistory: seed.prehistory };
}
