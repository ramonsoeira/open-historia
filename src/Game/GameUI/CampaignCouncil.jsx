/*! Open Historia — Workshop drafts and the country's public accounts. AGPL-3.0-or-later (see LICENSE). */
import React, { useEffect, useRef, useState } from "react";
import { compareGameDates, isCanonicalGameDate } from "../../runtime/gameDates.js";
import { fileCabinet, FUNDING_LEVELS, fundInitiative, openCouncil, publicAccounts, readCabinetProposal } from "../../runtime/civicCouncil.js";
import { mutateCanonicalTurnState, PROJECT_BOARD_LIMIT } from "../../runtime/gameState.js";
import { getActiveWorldDirection } from "../../runtime/gameFeatures.js";
import { assertNoTurnRunning } from "../AI/simulationStatus.js";
import { requestCampaignDraft } from "../AI/campaignDraft.js";
import "./campaignCouncil.css";

function useProposal(kind) {
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef(null);
  useEffect(() => () => abort.current?.abort(), []);
  const generate = async (input) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError(""); setValue(null);
    try {
      const next = await requestCampaignDraft(kind, input, { signal: controller.signal });
      if (!controller.signal.aborted) setValue(next);
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message);
    } finally {
      abort.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return { value, busy, error, generate, edit: setValue, clear: () => { setValue(null); setError(""); } };
}

function Roster({ record }) {
  return <div className="oh-council-roster">
    <div><h4>Ministries and annual costs</h4>
      {record.ministries.length ? <ul>{record.ministries.map(row =>
        <li key={row.office}><div><b data-no-translate>{row.office}</b><small data-no-translate>{row.holder || "—"}</small></div><strong>{row.annualCost}</strong></li>
      )}</ul> : <p>No ministries recorded.</p>}
    </div>
    <div><h4>Named legislators</h4>
      {record.legislators.length ? <ul>{record.legislators.map((row, index) =>
        <li key={index}><div><b data-no-translate>{row.name}</b><small data-no-translate>{[row.chamber, row.party].filter(Boolean).join(" · ")}</small></div></li>
      )}</ul> : <p>No individual legislators recorded.</p>}
    </div>
  </div>;
}

function BudgetStrip({ funds, revenue, upkeep }) {
  return <dl className="oh-council-budget">
    <div><dt>Available credits</dt><dd>{funds}</dd></div>
    <div><dt>Annual revenue</dt><dd>{revenue}</dd></div>
    <div><dt>Annual ministry costs</dt><dd>{upkeep}</dd></div>
  </dl>;
}

function RosterEditor({ draft, onChange }) {
  const setRow = (key, index, field, value) => onChange({ ...draft,
    [key]: draft[key].map((row, i) => i === index ? { ...row, [field]: value } : row) });
  return <details className="oh-council-form"><summary>Edit roster</summary>
    {draft.ministries.map((row, index) => <fieldset key={index}><legend>{row.office || "Ministry"}</legend>
      <label>Ministry<input value={row.office} maxLength={160} onChange={e => setRow("ministries", index, "office", e.target.value)} /></label>
      <label>Minister<input value={row.holder} maxLength={160} onChange={e => setRow("ministries", index, "holder", e.target.value)} /></label>
      <label>Annual cost<input type="number" min="0" max="1000000" value={row.annualCost} onChange={e => setRow("ministries", index, "annualCost", e.target.valueAsNumber || 0)} /></label>
      <button type="button" onClick={() => onChange({ ...draft, ministries: draft.ministries.filter((_, i) => i !== index) })}>Remove ministry</button>
    </fieldset>)}
    {draft.ministries.length < 32 && <button type="button" onClick={() => onChange({ ...draft, ministries: [...draft.ministries, { office: "", holder: "", annualCost: 0 }] })}>Add ministry</button>}
    {draft.legislators.map((row, index) => <fieldset key={index}><legend>{row.name || "Representative"}</legend>
      <label>Representative<input value={row.name} maxLength={160} onChange={e => setRow("legislators", index, "name", e.target.value)} /></label>
      <label>Chamber<input value={row.chamber} maxLength={160} onChange={e => setRow("legislators", index, "chamber", e.target.value)} /></label>
      <label>Party<input value={row.party} maxLength={160} onChange={e => setRow("legislators", index, "party", e.target.value)} /></label>
      <button type="button" onClick={() => onChange({ ...draft, legislators: draft.legislators.filter((_, i) => i !== index) })}>Remove representative</button>
    </fieldset>)}
    {draft.legislators.length < 80 && <button type="button" onClick={() => onChange({ ...draft, legislators: [...draft.legislators, { name: "", chamber: "", party: "" }] })}>Add representative</button>}
  </details>;
}

function CabinetPreview({ draft }) {
  return <><BudgetStrip funds={draft.openingFunds} revenue={draft.annualRevenue} upkeep={draft.ministries.reduce((sum, row) => sum + row.annualCost, 0)} />
    <Roster record={draft} />
    {draft.legislature && <p><b>Legislature</b> <span data-no-translate>{draft.legislature}</span></p>}
    {draft.nextElection && <p><b>Next election</b> <span data-no-translate>{draft.nextElection}</span></p>}
  </>;
}

function Chronology({ title, events }) {
  return <div><h4>{title}</h4><ol className="oh-council-dates">{events.map((row, index) => <li key={index}>
    <time data-no-translate>{row.date}</time><div><b data-no-translate>{row.title}</b><p data-no-translate>{row.text}</p></div>
  </li>)}</ol></div>;
}

export function ScenarioDraftPanel({ form, countries, onApply }) {
  const [premise, setPremise] = useState("");
  const [country, setCountry] = useState(form.country || "");
  const [applyError, setApplyError] = useState("");
  const proposal = useProposal("scenario");
  const chosen = countries.find(row => row.code === country);
  const draft = proposal.value;
  return <section className="oh-council">
    <h3>Draft a scenario with AI</h3>
    <p>Use the current map. Choose a starting country and describe the moment when history could change.</p>
    <label>Starting country<select value={country} disabled={proposal.busy} onChange={e => { setCountry(e.target.value); proposal.clear(); }}>
      <option value="">Choose a country</option>
      {countries.map(row => <option key={row.code} value={row.code}>{row.name}</option>)}
    </select></label>
    <label>Scenario premise<textarea value={premise} maxLength={3000} disabled={proposal.busy}
      onChange={e => { setPremise(e.target.value); proposal.clear(); }} /></label>
    <button type="button" disabled={!chosen || !premise.trim() || proposal.busy} onClick={() => proposal.generate({
      country, countryName: chosen.name, suggestedDate: form.gameDate, language: form.language, premise: premise.trim(),
    })}>{proposal.busy ? "Preparing draft…" : "Generate scenario draft"}</button>
    {proposal.error && <p role="alert">{proposal.error}</p>}
    {draft && <div className="oh-council-preview">
      <h3 data-no-translate>{draft.name}</h3><time data-no-translate>{draft.date}</time>
      <p data-no-translate>{draft.description}</p><p data-no-translate>{draft.background}</p><h4>Simulation rules</h4><p data-no-translate>{draft.rules}</p>
      <Chronology title="Before the start" events={draft.past} /><Chronology title="Possible futures" events={draft.future} />
      <CabinetPreview draft={draft.cabinet} />
      <RosterEditor draft={draft.cabinet} onChange={cabinet => proposal.edit({ ...draft, cabinet })} />
      <p>Applying replaces the scenario introduction, start date, rules and prehistory. It adds these possible futures and installs the proposed cabinet. Save the scenario to keep the changes.</p>
      <button type="button" onClick={() => {
        try {
          readCabinetProposal(draft.cabinet);
          onApply(draft, country); proposal.clear(); setApplyError("");
        } catch (err) { setApplyError(err.message); }
      }}>Apply to scenario</button>
      {applyError && <p role="alert">{applyError}</p>}
    </div>}
  </section>;
}

export function CountryCouncil({ world, country, player, gameId, onWorld, resolved = {} }) {
  const proposal = useProposal("cabinet");
  const [name, setName] = useState(""), [objective, setObjective] = useState("");
  const [cost, setCost] = useState(FUNDING_LEVELS[0]), [eventId, setEventId] = useState("");
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  if (!world || !country || !gameId || !isCanonicalGameDate(player.date)) return null;
  const date = player.date, mine = country === player.code;
  const council = world.civicCouncils?.[country];
  const account = publicAccounts(council || openCouncil(player.startDate || date), date);
  const schedule = getActiveWorldDirection()?.scriptedEvents || [];
  const future = schedule.filter(row => !resolved[row.id] && compareGameDates(row.date, date) > 0);
  const write = async (mutate) => {
    if (savingRef.current) return false;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const result = await mutateCanonicalTurnState(current => {
        assertNoTurnRunning();
        if (current.game.country !== player.code || current.game.gameDate !== date) throw new Error("The active country or date has changed.");
        return mutate(current);
      }, { expectedGameId: gameId });
      if (result?.world) onWorld?.(result.world);
      return true;
    } catch (err) { setError(err.message); return false; }
    finally { savingRef.current = false; setSaving(false); }
  };
  const fund = async () => {
    const id = globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    const request = { id: "civic-" + id, country, date, name, objective, cost, eventId };
    if (await write(current => fundInitiative(current, request, getActiveWorldDirection()?.scriptedEvents || [], PROJECT_BOARD_LIMIT))) {
      setName(""); setObjective(""); setEventId("");
    }
  };
  return <section className="oh-council">
    <h3>Cabinet and public accounts</h3>
    {(mine || council) && <><BudgetStrip funds={account.available} revenue={account.annualRevenue} upkeep={account.upkeep} />
      <p>Amounts are simulation credits. Revenue and ministry costs are posted at the start of each game month.</p></>}
    {council?.rosterDate && <><p><b>Government roster as of</b> <time data-no-translate>{council.rosterDate}</time></p><Roster record={council} /></>}
    <button type="button" disabled={proposal.busy || saving} onClick={() => proposal.generate({
      country, date, language: world.language || "English", background: String(world.startingTimelineText || "").slice(0, 2400),
      rules: String(world.simulationRules || "").slice(0, 1200),
      government: world.politicalActors?.byPolity?.[country]?.government, currentMinistries: council?.ministries,
    })}>{proposal.busy ? "Preparing draft…" : "Draft government roster"}</button>
    <button type="button" className="oh-council-secondary" disabled={proposal.busy || saving} onClick={() => {
      proposal.clear();
      proposal.edit({ ministries: council?.ministries || [], legislators: council?.legislators || [], openingFunds: 100, annualRevenue: account.annualRevenue,
        legislature: world.politicalActors?.byPolity?.[country]?.government?.legislature || "",
        nextElection: world.politicalActors?.byPolity?.[country]?.government?.nextElection || "" });
    }}>Enter roster manually</button>
    {proposal.error && <p role="alert">{proposal.error}</p>}
    {proposal.value && <div className="oh-council-preview"><h4>Proposed government</h4>
      <CabinetPreview draft={{ ...proposal.value, openingFunds: council ? account.available : proposal.value.openingFunds }} />
      <RosterEditor draft={proposal.value} onChange={proposal.edit} />
      <p>Review the names and estimates for this date before filing them.</p>
      <button type="button" disabled={saving} onClick={async () => {
        if (await write(current => ({ world: fileCabinet(current.world, country, date, proposal.value) }))) proposal.clear();
      }}>File government roster</button></div>}
    {mine && <details className="oh-council-form"><summary>Fund an initiative</summary>
      <p>The simulator resolves your objective through the project board. A project completed before its linked event can avert that event.</p>
      <label>Initiative name<input value={name} maxLength={160} onChange={e => setName(e.target.value)} /></label>
      <label>Political objective<textarea value={objective} maxLength={700} onChange={e => setObjective(e.target.value)} /></label>
      <label>Funding in credits<select value={cost} onChange={e => setCost(Number(e.target.value))}>{FUNDING_LEVELS.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Event to avert<select value={eventId} onChange={e => setEventId(e.target.value)}>
        <option value="">Independent initiative</option>{future.map(beat => <option key={beat.id} value={beat.id}>{beat.date} · {beat.title}</option>)}
      </select></label>
      <button type="button" disabled={saving || !name.trim() || !objective.trim() || cost > account.available} onClick={fund}>Authorize funding</button>
    </details>}
    {mine && Object.values(resolved).some(row => row.cause || row.divertedBy) && <div><h4>Changes to the timeline</h4>
      <ul className="oh-council-ledger">{Object.entries(resolved).filter(([, row]) => row.cause || row.divertedBy).map(([id, row]) =>
        <li key={id}><b data-no-translate>{schedule.find(beat => beat.id === id)?.title || id}</b>
          <small>{row.outcome === "fired" ? "Happened early" : "Scheduled event averted"}</small>
          <small data-no-translate>{row.resolvedDate} · {row.cause || row.divertedBy}</small>
        </li>)}</ul></div>}
    {mine && Boolean(council?.appropriations.length) && <div><h4>Authorized spending</h4>
      <ul className="oh-council-ledger">{council.appropriations.slice().reverse().map(row => <li key={row.id}>
        <div><b data-no-translate>{row.name}</b><small>{row.date} · {row.cost}</small></div>
        {row.eventTitle && <small data-no-translate>{row.eventTitle}</small>}
        {row.completedOn && <small><b>Completed</b> {row.completedOn}</small>}
        {resolved[row.eventId]?.divertedBy === row.name && <small>Scheduled event averted</small>}
      </li>)}</ul></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
