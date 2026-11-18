/*! Open Historia — cabinet rosters, public accounts and parliamentary initiatives. AGPL-3.0-or-later (see LICENSE). */
import { astronomicalYear, compareGameDates, isCanonicalGameDate, parseGameDate } from "./gameDates.js";

const text = (value, limit = 160) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const rows = (value) => Array.isArray(value) ? value : [];
const amount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
const safeKey = (key) => typeof key === "string" && key === text(key) && Boolean(key) && !Object.hasOwn(Object.prototype, key) && key !== "prototype";

export const FUNDING_LEVELS = [10, 25, 50];

export function readCabinetProposal(value) {
  if (!value || !amount(value.openingFunds) || !amount(value.annualRevenue)) throw new Error("The proposed budget needs valid whole amounts.");
  const ministries = rows(value.ministries).slice(0, 32).map(row => {
    if (!text(row?.office) || !amount(row.annualCost)) throw new Error("Each ministry needs a name and an annual cost.");
    return { office: text(row.office), holder: text(row.holder), annualCost: row.annualCost };
  });
  const legislators = rows(value.legislators).slice(0, 80).map(row => {
    if (!text(row?.name) || !text(row.chamber)) throw new Error("Each representative needs a name and a chamber.");
    return { name: text(row.name), chamber: text(row.chamber), party: text(row.party) };
  });
  if (new Set(ministries.map(row => row.office.toLowerCase())).size !== ministries.length) throw new Error("The proposal lists a ministry twice.");
  return { ministries, legislators, openingFunds: value.openingFunds, annualRevenue: value.annualRevenue,
    legislature: text(value.legislature), nextElection: text(value.nextElection, 80) };
}

// Imported worlds can predate this ledger or contain incomplete records. Ignore
// malformed entries at the same boundary that already normalizes the rest of a save.
export function normalizeCouncils(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (!safeKey(key) || !isCanonicalGameDate(entry?.asOf) || !Number.isSafeInteger(entry.reserveTwelfths) || !amount(entry.annualRevenue)) continue;
    let profile;
    try { profile = readCabinetProposal({ ...entry, openingFunds: 0 }); } catch { continue; }
    const appropriations = [];
    const seen = new Set();
    for (const row of rows(entry.appropriations)) {
      if (!safeKey(row?.id) || seen.has(row.id) || !text(row.name) || !amount(row.cost) || !isCanonicalGameDate(row.date)) continue;
      seen.add(row.id);
      appropriations.push({ id: text(row.id), name: text(row.name), date: row.date, cost: row.cost,
        ...(text(row.eventId) && isCanonicalGameDate(row.eventDate) ? { eventId: text(row.eventId), eventTitle: text(row.eventTitle), eventDate: row.eventDate } : {}),
        ...(isCanonicalGameDate(row.completedOn) ? { completedOn: row.completedOn } : {}) });
    }
    result[key] = { asOf: entry.asOf, annualRevenue: entry.annualRevenue, reserveTwelfths: entry.reserveTwelfths,
      ...(isCanonicalGameDate(entry.rosterDate) ? { rosterDate: entry.rosterDate } : {}),
      ministries: profile.ministries, legislators: profile.legislators, appropriations };
  }
  return result;
}

const monthIndex = (date) => {
  const parts = parseGameDate(date);
  if (!parts) throw new Error("A valid campaign date is required.");
  return astronomicalYear(parts.year) * 12 + parts.month - 1;
};

// Post one twelfth of annual revenue and upkeep on the first of each game month.
// Holding twelfths across settlements avoids gaining a credit by splitting a turn.
export function publicAccounts(council, date) {
  const months = Math.max(0, monthIndex(date) - monthIndex(council.asOf));
  const upkeep = council.ministries.reduce((sum, row) => sum + row.annualCost, 0);
  const twelfths = council.reserveTwelfths + months * (council.annualRevenue - upkeep);
  return { available: Math.floor(twelfths / 12), twelfths, upkeep, annualRevenue: council.annualRevenue };
}

export function openCouncil(date) {
  if (!isCanonicalGameDate(date)) throw new Error("A valid campaign date is required.");
  return { asOf: date, reserveTwelfths: 1200, annualRevenue: 120, ministries: [], legislators: [], appropriations: [] };
}

export function fileCabinet(world, country, date, proposal, { startingWorld = false } = {}) {
  if (!safeKey(country) || !isCanonicalGameDate(date)) throw new Error("A country and campaign date are required.");
  const data = readCabinetProposal(proposal);
  const old = startingWorld ? null : world.civicCouncils?.[country];
  if (old && compareGameDates(date, old.asOf) < 0) throw new Error("The government record has moved beyond this date.");
  const council = { asOf: date, rosterDate: date, ministries: data.ministries, legislators: data.legislators,
    annualRevenue: data.annualRevenue, reserveTwelfths: old ? publicAccounts(old, date).twelfths : data.openingFunds * 12,
    appropriations: old?.appropriations || [] };
  const actors = world.politicalActors || {};
  const actor = actors.byPolity?.[country] || { polityKey: country };
  const government = { ...actor.government };
  // The election ledger may already have moved on from the date remembered by a model.
  if ((startingWorld || !government.legislature) && data.legislature) government.legislature = data.legislature;
  if ((startingWorld || !government.nextElection) && data.nextElection) government.nextElection = data.nextElection;
  return { ...world, civicCouncils: { ...world.civicCouncils, [country]: council },
    politicalActors: { ...actors, byPolity: { ...actors.byPolity, [country]: { ...actor, government } } } };
}

// The treasury, project and order are one canonical mutation. Retrying the
// same authorization is harmless even if the browser did not get its receipt.
export function fundInitiative({ world, game, actions }, request, schedule, boardLimit = 120) {
  const country = game.country;
  if (!safeKey(country) || country !== request.country || game.gameDate !== request.date) throw new Error("The active country or date has changed.");
  const date = game.gameDate;
  const council = world.civicCouncils?.[country] || openCouncil(game.startDate || date);
  const id = text(request.id);
  if (!id || !safeKey(id)) throw new Error("The initiative needs an identifier.");
  if (council.appropriations.some(row => row.id === id)) return null;
  const name = text(request.name), objective = text(request.objective, 700);
  if (!name || !objective) throw new Error("Enter an initiative name and its objective.");
  if (!FUNDING_LEVELS.includes(request.cost)) throw new Error("Choose a funding level.");
  if (compareGameDates(date, council.asOf) < 0) throw new Error("The government record has moved beyond this date.");
  const accounts = publicAccounts(council, date);
  if (request.cost > accounts.available) throw new Error("There are insufficient funds for this initiative.");
  const eventId = text(request.eventId);
  const target = eventId && rows(schedule).find(beat => beat.id === eventId);
  if (eventId && (!target || compareGameDates(target.date, date) <= 0 || game.scriptedEventState?.[eventId])) throw new Error("Choose a future event still on the calendar.");
  if (rows(world.projects).length >= boardLimit) throw new Error("The project board is full.");
  const appropriation = { id, name, cost: request.cost, date, ...(target ? { eventId, eventTitle: target.title, eventDate: target.date } : {}) };
  const project = { id, name, summary: objective, ownerCode: country, startedAt: date, targetDate: target?.date || "",
    priority: "high", kind: "project", status: "active", updatedRound: game.round };
  const order = { id, title: name, text: objective, rawInput: objective, ownerCode: country, status: "planned", kind: "action", source: "manual" };
  return { world: { ...world, projects: [...rows(world.projects), project], civicCouncils: { ...world.civicCouncils,
    [country]: { ...council, asOf: date, reserveTwelfths: accounts.twelfths - request.cost * 12, appropriations: [...council.appropriations, appropriation] } } },
    actions: [...rows(actions), order] };
}

// Record completion before the board can archive an old project. The game date
// belongs to the accepted turn. Wall-clock timestamps would change on a replay.
export function recordCouncilCompletions(world, date) {
  if (!world.civicCouncils || !isCanonicalGameDate(date)) return world;
  const complete = new Set(rows(world.projects).filter(row => row.status === "complete").map(row => row.id));
  for (const [country, council] of Object.entries(world.civicCouncils)) {
    if (!council.appropriations.some(row => !row.completedOn && complete.has(row.id))) continue;
    world = { ...world, civicCouncils: { ...world.civicCouncils, [country]: { ...council, appropriations: council.appropriations.map(
      row => !row.completedOn && complete.has(row.id) ? { ...row, completedOn: date } : row) } } };
  }
  return world;
}

export function divertedEvents(world) {
  const diverted = new Map();
  for (const council of Object.values(world?.civicCouncils || {})) {
    for (const row of council.appropriations) {
      if (row.eventId && row.completedOn && compareGameDates(row.completedOn, row.eventDate) < 0 && !diverted.has(row.eventId)) diverted.set(row.eventId, row);
    }
  }
  return diverted;
}

export function describeCouncil(world, country, date) {
  const council = world?.civicCouncils?.[country];
  if (!council || !isCanonicalGameDate(date)) return "";
  const budget = publicAccounts(council, date);
  const offices = council.ministries.map(row => [row.office, row.holder].filter(Boolean).join(" — ")).join(", ");
  const members = council.legislators.slice(0, 12).map(row => [row.name, row.chamber, row.party].filter(Boolean).join(" / ")).join(", ");
  const recent = council.appropriations.slice(-6).map(row => row.name + " (" + row.cost + (row.completedOn ? ", completed " + row.completedOn : "") + ")").join(", ");
  return ["[Public accounts of " + country + "]", "Simulation credits available " + budget.available + ", annual revenue " + budget.annualRevenue + ", annual ministry costs " + budget.upkeep + ".",
    offices && "Cabinet: " + offices, members && "Legislators: " + members, recent && "Funded initiatives: " + recent,
    "Weigh the funds committed, opposition and the project's actual progress when resolving the player's objectives. Record material progress or failure on its project using its existing id. For covert programs, describe only strategic outcomes, oversight, cost and diplomatic fallout."].filter(Boolean).join("\n");
}
