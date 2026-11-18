/*! Open Historia — alternate futures during a time skip. AGPL-3.0-or-later (see LICENSE). */
import { planScriptedEvents } from "./scriptedEventResolution.js";
import { compareGameDates, isCanonicalGameDate } from "../../runtime/gameDates.js";
import { scriptedImpactsOf, mergeAuthoredImpacts, describeScriptedImpacts } from "./scriptedEventImpacts.js";
import { SCRIPTED_EVENT } from "./worldDirection.js";

const forecastId = (beat) => "forecast-" + beat.id;

// Explicit branches, exact quotations and events on which other rules depend
// retain their native resolution. The rest can follow the developing story.
export function flexibleBeatIds(schedule, enabled) {
  if (!enabled) return new Set();
  const referenced = new Set(schedule.flatMap(beat => (beat.trigger?.conditions || []).map(rule => rule.eventId).filter(Boolean)));
  return new Set(schedule.filter(beat => !referenced.has(beat.id) && beat.textMode !== "exact"
    && !beat.outcomes?.length && !beat.trigger?.conditions?.length
    && ["always", "rules"].includes(beat.trigger?.mode || "always") && (beat.trigger?.percent ?? 100) === 100).map(beat => beat.id));
}

export function openHistoryInstruction(beats, resolutions = []) {
  const diverted = resolutions.filter(row => row.divertedBy);
  if (!beats.length && !diverted.length) return "";
  return ["[Possible futures]", "The following are historical expectations. Decide from the actual campaign, player orders, institutions and resources. When decisions change the outcome, write the alternative and its cause. Never force history back on course.",
    "Only if a forecast actually happens, use its exact event id and scheduled date on the event that reports it. For a different outcome, use a different id.",
    ...beats.map(beat => [forecastId(beat), beat.date, beat.title, beat.text, describeScriptedImpacts(scriptedImpactsOf(beat))].filter(Boolean).join(" | ")),
    ...diverted.map(row => "Already averted by the completed initiative " + row.divertedBy + ": " + row.event.title + ". Carry its consequences forward.")].join("\n");
}

const reported = (entry, beat) => entry?.id === forecastId(beat) && entry.date === beat.date;

// The model's event id binds a selected forecast even in translated prose.
// A missing forecast cannot introduce a border change or an election by itself.
export function applyForecastImpacts(events, beats) {
  for (const beat of beats) {
    const event = events?.find(row => reported(row, beat));
    if (!event) continue;
    event[SCRIPTED_EVENT] = true;
    event.impacts = mergeAuthoredImpacts(event.impacts, scriptedImpactsOf(beat));
  }
}

export function resolveForecasts(plan, beats, events, throughDate) {
  if (!beats.length) return plan;
  const byId = new Map(beats.map(beat => [beat.id, beat]));
  return { ...plan, resolutions: plan.resolutions.map(row => {
    const beat = byId.get(row.event.id);
    if (!beat || compareGameDates(beat.date, throughDate) > 0) return row;
    return { ...row, outcome: events.some(event => reported(event, beat)) ? "fired" : "skipped", mode: "open" };
  }) };
}

// The player need not fund or link a project. The simulator can bind an
// ordinary action's accepted outcome to a later script using its event id.
export function futureBrief(schedule, { date, resolved, actions = [], projects = [] }) {
  const future = schedule.filter(beat => !resolved?.[beat.id] && compareGameDates(beat.date, date) > 0);
  const words = value => new Set(String(value || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\d]{4,}/gu) || []);
  const subjects = words([...actions.filter(action => action.status === "planned").map(action => action.text),
    ...projects.filter(row => row.status === "active" && row.priority === "high").map(row => row.name)].join(" "));
  const score = beat => [...words(beat.title + " " + beat.text)].filter(term => subjects.has(term)).length;
  const candidates = future.map(beat => ({ beat, score: score(beat) })).sort((a, b) => b.score - a.score || compareGameDates(a.beat.date, b.beat.date));
  return candidates.slice(0, 18).map(row => row.beat);
}

export function continuityInstruction(upcoming, resolved = {}) {
  const precedents = Object.entries(resolved).filter(([, r]) => r.cause || r.divertedBy).slice(-10);
  return ["[Open campaign chronology]",
    "Historical dates are expectations. A player may try any plausible action early, including changing a government before a historical succession. Judge feasibility now. A recorded change of leadership, office, or treaty is binding in later events. Never restore a departed officeholder or repeat an accomplished event to follow real history.",
    "An order is an attempt. Only on the dated event that actually settles it, give the event the id early-<script id> if the historical outcome came early, or averted-<script id> if a different outcome made it impossible. Cite an actual queued order in impacts.actionIds or finish an existing project, and write the lasting change in its normal impacts. Use ordinary ids for plans, failed or inconclusive attempts. Describe covert outcomes at the strategic level.",
    "This rule takes priority over the original date and any request to reproduce an event whose preconditions have disappeared.",
    ...upcoming.map(beat => beat.id + " | " + beat.date + " | " + beat.title + " | " + beat.text.slice(0, 240)),
    ...precedents.map(([id, row]) => "Established " + row.resolvedDate + " (" + id + ", " + row.outcome + "): " + (row.cause || row.divertedBy))].join("\n");
}

export function earlyDecisions(events, schedule, { actions = [], projects = [], from, through, resolved = {} }) {
  const knownOrders = new Set(actions.filter(action => action.status === "planned").map(action => action.id));
  const knownProjects = new Set(projects.map(row => row.id));
  const byId = new Map(schedule.map(beat => [beat.id, beat]));
  const decisions = {};
  for (const event of events || []) {
    const match = /^(early|averted)-(.+)$/.exec(event?.id || "");
    const beat = match && byId.get(match[2]);
    if (!beat || Object.hasOwn(decisions, beat.id) || Object.hasOwn(resolved, beat.id) || !event.title
      || !isCanonicalGameDate(event.date) || compareGameDates(event.date, from) <= 0 || compareGameDates(event.date, through) > 0
      || compareGameDates(event.date, beat.date) >= 0) continue;
    const impacts = event.impacts || {};
    const completedProject = (impacts.projectOps || []).some(op => knownProjects.has(op.projectId || op.id)
      && (op.op === "complete" || op.status === "complete" || op.patch?.status === "complete"));
    const groundedAction = (impacts.actionIds || []).some(id => knownOrders.has(id))
      && ["polityChanges", "politicalActorOps", "regionTransfers", "regionControlOps", "institutionOps", "agreementOps", "markerOps"]
        .some(key => Array.isArray(impacts[key]) && impacts[key].length);
    if (!groundedAction && !completedProject) continue;
    decisions[beat.id] = { mode: match[1], outcome: match[1] === "early" ? "fired" : "skipped",
      date: beat.date, resolvedDate: event.date, cause: event.title.slice(0, 180) };
  }
  return decisions;
}

// A dependent event sees a changed outcome only from the date the player
// achieved it. Unaffected events keep the original chance and branch rolls.
export function replanAfterDecisions(plan, decisions, { world, resolved, rolls }) {
  if (!Object.keys(decisions).length) return plan;
  const changed = new Set(Object.keys(decisions));
  const outcomes = { ...resolved };
  const resolutions = [], eligible = [];
  for (const row of plan.resolutions || []) {
    const beat = row.event;
    for (const [id, entry] of Object.entries(decisions)) {
      if (compareGameDates(entry.resolvedDate, beat.date) <= 0) outcomes[id] = entry;
    }
    if (decisions[beat.id]) continue;
    if (!beat.trigger?.conditions?.some(rule => changed.has(rule.eventId))) {
      resolutions.push(row);
      outcomes[beat.id] = row;
      if (row.outcome === "fired") eligible.push(plan.eligible.find(entry => entry.id === beat.id));
      continue;
    }
    changed.add(beat.id);
    const saved = rolls[beat.id] ||= [];
    const originals = [row.roll, row.outcomeRoll].filter(Number.isFinite);
    let index = 0;
    const result = planScriptedEvents([beat], { world, resolvedState: outcomes, random: () => {
      const i = index++;
      return saved[i] ??= originals[i] ?? Math.random();
    } });
    resolutions.push(...result.resolutions);
    eligible.push(...result.eligible);
    outcomes[beat.id] = result.resolutions[0];
  }
  return { ...plan, resolutions, eligible };
}

// A model can report the change early and also repeat the original card later
// in its answer. Remove only a replay explicitly labelled with the same id,
// or the same scheduled headline on its original date. A dated reaction with
// a different headline remains part of the campaign.
export function retireHistoricalReplays(candidate, schedule, resolutions) {
  const retired = schedule.filter(beat => resolutions[beat.id]?.cause || resolutions[beat.id]?.divertedBy);
  if (!retired.length) return;
  const rem = new Set();
  candidate.events = (candidate.events || []).filter(event => {
    const duplicate = retired.some(beat => {
      const recorded = resolutions[beat.id];
      if (compareGameDates(event.date, recorded.resolvedDate) < 0) return false;
      return event.id === forecastId(beat) || (event.date === beat.date && String(event.title).trim().toLowerCase() === beat.title.trim().toLowerCase());
    });
    if (duplicate && event.id) rem.add(event.id);
    return !duplicate;
  });
  for (const family of ["warUpdates", "agreementUpdates", "relationUpdates", "puppetUpdates", "storylineUpdates", "frontOrders"]) {
    if (Array.isArray(candidate[family]) && rem.size) candidate[family] = candidate[family].filter(row => !rem.has(row.eventId));
  }
}
