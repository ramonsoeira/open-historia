/*! Open Historia — alternate history, scenario authoring and fiscal regression cases. AGPL-3.0-or-later (see LICENSE). */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFeatureSettings, normalizeScriptedEvents, resolveFeatures, worldDirectionOf } from "../../../server/gameFeatures.js";
import { applyScenarioDraft, readScenarioDraft, requestCampaignDraft, withCampaignSeed } from "./campaignDraft.js";
import { applyForecastImpacts, earlyDecisions, flexibleBeatIds, futureBrief, replanAfterDecisions, resolveForecasts, retireHistoricalReplays } from "./openHistory.js";
import { planScriptedEvents, commitScriptedEventPlan, normalizeScriptedEventState } from "./scriptedEventResolution.js";
import { advanceElectionCalendar, describeElectionsDue } from "../../runtime/politics.js";
import { applyEventImpactsToWorld } from "../../runtime/gameState.js";
import { getPoliticalProfile } from "../../runtime/politicalActors.js";
import { fileCabinet, fundInitiative, normalizeCouncils, openCouncil, publicAccounts, recordCouncilCompletions } from "../../runtime/civicCouncil.js";

const country = "Republic";
const cabinet = { ministries: [{ office: "Treasury", holder: "Ana Vale", annualCost: 23 }],
  legislators: [{ name: "Jo Lima", chamber: "Assembly", party: "Civic" }], openingFunds: 100, annualRevenue: 120,
  legislature: "Assembly", nextElection: "1944-07-02" };
const game = { country, startDate: "1944-01-01", gameDate: "1944-06-01", round: 3 };
const schedule = normalizeScriptedEvents([
  { id: "succession", date: "1944-07-20", title: "Government succession", text: "A new cabinet takes office.",
    impactRows: [{ type: "leader", polity: country, leader: "Ana Vale" }] },
  { id: "talks", date: "1944-07-21", title: "New talks", text: "Delegates meet if the scheduled transition failed.",
    trigger: { mode: "conditional", conditions: [{ type: "scripted_event_skipped", eventId: "succession" }] } },
  { id: "forum", date: "1944-08-10", title: "Trade forum", text: "The two trade councils meet." },
]);
const actions = [{ id: "order-7", text: "Bring forward the change of government", status: "planned" }];
const evidence = { actions, from: "1944-06-01", through: "1944-07-31" };
const early = { id: "early-succession", date: "1944-06-15", title: "The new cabinet takes office in June",
  description: "The assembly confirms its new head of state.",
  impacts: { actionIds: ["order-7"], politicalActorOps: [{ op: "replace-leader", polityKey: country,
    argsJson: JSON.stringify({ office: "headOfState", leader: { name: "Ana Vale" } }) }] } };

test("an ordinary order can settle a July succession in June and a reloaded campaign never stages it again", () => {
  const shortlist = futureBrief(schedule, { date: evidence.from, actions, resolved: {} });
  const decisions = earlyDecisions([early], shortlist, evidence);
  const state = normalizeScriptedEventState(JSON.parse(JSON.stringify(decisions)));
  assert.deepEqual(state.succession, { mode: "early", outcome: "fired", date: "1944-07-20", resolvedDate: "1944-06-15", cause: early.title });
  const july = planScriptedEvents(schedule.slice(0, 2), { resolvedState: state });
  assert.deepEqual(july.eligible, []);
  assert.equal(july.resolutions[0].outcome, "skipped");
  const incumbent = { polityKey: country, name: country, government: { headOfState: { name: "Incumbent" } } };
  const { world } = applyEventImpactsToWorld({ colors: {}, world: { ownerCodes: [country],
    politicalActors: { schemaVersion: 1, byPolity: { [country]: incumbent } } }, events: [early] });
  assert.equal(getPoliticalProfile(world, country).government.headOfState.name, "Ana Vale");
});

test("an attempt, a proposal, an unknown order or a preview beyond an early stop settles nothing", () => {
  for (const event of [
    { ...early, id: "normal" }, { ...early, impacts: { actionIds: ["order-7"] } },
    { ...early, impacts: { actionIds: ["order-7"], projectOps: [{ op: "create", name: "Proposal" }] } },
    { ...early, impacts: { ...early.impacts, actionIds: ["foreign"] } }, { ...early, date: "1944-07-20" },
  ]) assert.deepEqual(earlyDecisions([event], schedule, evidence), {});
  assert.deepEqual(earlyDecisions([early], schedule, { ...evidence, through: "1944-06-14" }), {});
});

test("an earlier alternative in the same long turn suppresses original impacts and activates the skipped-event branch", () => {
  const original = planScriptedEvents(schedule);
  const decisions = earlyDecisions([{ ...early, id: "averted-succession" }], schedule, evidence);
  const replanned = replanAfterDecisions(original, decisions, { world: {}, resolved: {}, rolls: {} });
  assert.deepEqual(replanned.eligible.map(row => row.id), ["talks", "forum"]);
  const committed = commitScriptedEventPlan(decisions, replanned, { throughDate: "1944-07-31" });
  assert.equal(committed.state.succession.outcome, "skipped");
  assert.equal(committed.state.talks.outcome, "fired");
  assert.equal(committed.state.forum, undefined);
});

test("an ordinary dated forecast can disappear whereas exact scripts and rule dependencies stay authored", () => {
  assert.equal(worldDirectionOf(normalizeFeatureSettings({})).openHistory, true);
  assert.equal(worldDirectionOf(resolveFeatures({}, { worldDirection: { openHistory: false } })).openHistory, false);
  const flexible = flexibleBeatIds(schedule, true);
  assert.deepEqual([...flexible], ["forum"]);
  assert.equal(flexibleBeatIds(schedule, false).size, 0);
  const beats = [schedule[2]], plan = planScriptedEvents(beats);
  const events = [{ id: "different", date: beats[0].date }];
  applyForecastImpacts(events, beats);
  assert.equal(events[0].impacts, undefined);
  assert.equal(resolveForecasts(plan, beats, events, "1944-08-10").resolutions[0].outcome, "skipped");
  const actual = [{ id: "forecast-forum", date: beats[0].date }];
  assert.equal(resolveForecasts(plan, beats, actual, "1944-08-10").resolutions[0].outcome, "fired");
});

test("funding is atomic and idempotent, and only a completed project can change a linked event", () => {
  const world = fileCabinet({}, country, game.gameDate, cabinet);
  const request = { country, date: game.gameDate, id: "civic-test", name: "Constitutional convention", objective: "Negotiate a different succession.", cost: 25, eventId: "succession" };
  const input = { world, game, actions: [] };
  const funded = fundInitiative(input, request, schedule);
  assert.equal(publicAccounts(funded.world.civicCouncils[country], game.gameDate).available, 75);
  assert.equal(funded.actions[0].id, funded.world.projects[0].id);
  assert.equal(fundInitiative({ ...funded, game }, request, schedule), null);
  assert.equal(planScriptedEvents(schedule, { world: funded.world }).eligible[0].id, "succession");
  const done = recordCouncilCompletions({ ...funded.world, projects: [{ ...funded.world.projects[0], status: "complete" }] }, "1944-06-28");
  const planned = planScriptedEvents(schedule, { world: { ...done, projects: [] } });
  const committed = commitScriptedEventPlan({}, planned, { throughDate: "1944-07-22" });
  assert.equal(committed.state.succession.divertedBy, request.name);
  assert.equal(committed.state.talks.outcome, "fired");
  assert.equal(world.civicCouncils[country].reserveTwelfths, 1200);
  assert.throws(() => fundInitiative(input, { ...request, date: "1944-06-02" }, schedule), /date has changed/);
  assert.throws(() => fundInitiative(input, request, schedule, 0), /board is full/);
  assert.throws(() => fundInitiative({ ...input, world: fileCabinet({}, country, game.gameDate, { ...cabinet, openingFunds: 0 }) }, request, schedule), /insufficient/);
});

test("monthly costs span BC and AD, and refiling cannot replenish a treasury or compound rounding", () => {
  const initial = fileCabinet({}, country, "-0001-12-30", cabinet);
  const after = fileCabinet(initial, country, "0001-02-11", { ...cabinet, openingFunds: 999 });
  assert.equal(publicAccounts(after.civicCouncils[country], "0001-03-01").twelfths, publicAccounts(initial.civicCouncils[country], "0001-03-01").twelfths);
  assert.equal(publicAccounts(after.civicCouncils[country], "0001-03-01").available, 124);
  assert.deepEqual(normalizeCouncils({ ...initial.civicCouncils, broken: { asOf: "bad" } }), initial.civicCouncils);
  assert.equal(publicAccounts(openCouncil(game.startDate), game.gameDate).available, 150);
});

test("a proposed scenario travels through the real provider contract, editor form and save seed", async () => {
  const raw = { name: "Republic at a crossroads", date: game.gameDate, description: "A contested assembly.",
    background: "A constitutional convention opened.", rules: "Government changes follow the campaign.", cabinet,
    past: [{ date: "1944-05-01", title: "The assembly opens", text: "Parties convene." }], future: [schedule[2]] };
  const draft = await requestCampaignDraft("scenario", { country, premise: "A constitutional convention" }, {
    ask: async (instruction, _input, tool) => {
      assert.equal(tool.name, "submit_scenario_draft");
      assert.match(instruction, /uncertain people/);
      return raw;
    },
  });
  const form = applyScenarioDraft({ features: { wars: { enabled: false }, worldDirection: { scriptedEvents: [schedule[0]] } } }, draft, country);
  assert.equal(form.features.wars.enabled, false);
  assert.equal(form.features.worldDirection.openHistory, true);
  assert.equal(form.features.worldDirection.scriptedEvents.length, 2);
  const seed = withCampaignSeed({ ownerCodes: [country], regions: [4] }, form.campaignSeed);
  assert.equal(seed.civicCouncils[country].legislators[0].name, "Jo Lima");
  assert.equal(seed.prehistory.events[0].date, "1944-05-01");
  assert.deepEqual(seed.regions, [4]);
  assert.equal(seed.politicalActors.byPolity[country].government.nextElection, "1944-07-02");
  assert.throws(() => readScenarioDraft({ ...raw, future: [raw.past[0]] }), /outside its period/);
});

test("an election inside a time skip is due once, including across a year boundary", () => {
  const actors = { byPolity: { Republic: { government: { nextElection: "1945-01-03" } } } };
  const span = { fromDate: "1944-12-28", date: "1945-01-05" };
  assert.match(describeElectionsDue(actors, span), /Republic/);
  assert.equal(describeElectionsDue(actors, { ...span, date: "1945-01-02" }), "");
  const next = advanceElectionCalendar(actors, [{ impacts: { politicalActorOps: [
    { op: "set-government", polityKey: "Republic", argsJson: JSON.stringify({ patch: { nextElection: "1949-01-03" } }) },
  ] } }]);
  assert.equal(describeElectionsDue(next, { fromDate: span.date, date: "1945-01-15" }), "");
  assert.equal(actors.byPolity.Republic.government.nextElection, "1945-01-03");
});

test("a July replay of a June succession is removed while a later political reaction survives", () => {
  const resolutions = earlyDecisions([early], schedule, evidence);
  const candidate = { events: [early, { id: "repeat", title: schedule[0].title, date: schedule[0].date },
    { id: "response", title: "Assembly reviews the June transition", date: schedule[0].date }],
    relationUpdates: [{ eventId: "repeat" }, { eventId: "response" }] };
  retireHistoricalReplays(candidate, schedule, resolutions);
  assert.deepEqual(candidate.events.map(row => row.id), [early.id, "response"]);
  assert.deepEqual(candidate.relationUpdates, [{ eventId: "response" }]);
});
