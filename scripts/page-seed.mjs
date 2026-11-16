// Sample data for `pnpm page:check --seed`: rows for the pages that only fill from live events (Current Meta, Watching, the New Meta
// banner, meme cards of both sources, a Tech Proposal with its Score). Every name is plainly fake and carries SEED, so a screenshot
// cannot be mistaken for live data. Written through the production Datastore write paths (never raw SQL), so a schema change breaks
// the seed test loudly. The clock is passed in: nothing here reads Date.now().
// Ticket: .scratch/warroom-redesign/issues/14-page-check-seed-option.md
// The core fixtures are imported inside seedDatastore, so a plain `page:check` (no --seed) does not load the Datastore.

// The `{token}` names an explicit --seed path can use, each replaced by that Proposal's id.
export const SEED_TOKENS = ['tech', 'metaMeme', 'newsMeme', 'hostile'];

// The standard set `--seed --all` checks (`{token}` pages are filled from the fixture).
export const STANDARD_PATHS = ['/', '/?kind=meme', '/meta', '/meta#all-launch-themes', '/proposals/{tech}', '/proposals/{metaMeme}', '/proposals/{newsMeme}', '/proposals/{hostile}'];

// Replaces `{token}` in a path. Throws on a token that is not in SEED_TOKENS, or (with `ids`) has no id.
export function expandTokens(pagePath, ids) {
  return pagePath.replace(/\{([^{}]*)\}/g, (whole, name) => {
    if (!SEED_TOKENS.includes(name)) throw new Error(`unknown seed token ${whole}; use ${SEED_TOKENS.map((t) => `{${t}}`).join(', ')}`);
    const id = ids?.[name];
    if (ids && !Number.isInteger(id)) throw new Error(`seed token ${whole} has no id`);
    return ids ? String(id) : '1';
  });
}

// A path with any stray brace left after expansion is refused too (`{`, `}` alone).
export function pathProblem(pagePath) {
  let expanded;
  try {
    expanded = expandTokens(pagePath);
  } catch (err) {
    return err.message;
  }
  return /[{}]/.test(expanded) ? `path "${pagePath}" has an unmatched brace` : null;
}

const MIN = 60_000;
const HOUR = 3_600_000;

export const HOSTILE_NAME = '<script>alert("SEED hostile")</script><img src=x onerror=alert(1)>';
export const HOSTILE_TICKER = `SEED${'X'.repeat(120)}`;

function idea(name, ticker, angle) {
  return {
    name,
    ticker,
    angle,
    description: `SEED sample pitch for ${name}.`,
    difference: 'SEED sample: it jokes about the story, not the logo.',
    hook: `SEED sample first post for ${name}.`,
    imageIdea: 'SEED sample: a chair in a spotlight.',
    riskLabels: ['sample data'],
  };
}

// Writes the fixture rows into `store` and returns { ids, counts }. `now` is a Date. Run it once on an empty store.
export async function seedDatastore(store, now) {
  const { aMeta, saveCurrentRun } = await import('../packages/core/src/testing/meta-current.ts');
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * MIN).toISOString();
  const counts = { source_polls: 0, signals: 0, narratives: 0, scores: 0, meta_runs: 0, new_meta_events: 0, proposals: 0 };

  // The Metas (one holding its place, one cooling), two Watching subjects, and the New Meta event for the first.
  const chair = aMeta('seed-chair', { label: 'SEED Empty Chair', leaderName: 'SEED Chair coin', leaderSymbol: 'SEEDCHAIR', cap: 2_400_000, creators: 14, enteredAt: at(180) });
  const lobster = aMeta('seed-lobster', { label: 'SEED Lobster Hat', leaderName: 'SEED Lobster coin', leaderSymbol: 'SEEDLOB', cap: 1_100_000, creators: 9, holding: true, enteredAt: at(20 * 60) });
  const cloud = aMeta('seed-cloud', { label: 'SEED Cloud Cat', leaderName: 'SEED Cloud coin', leaderSymbol: 'SEEDCLD', cap: 380_000, creators: 6, enteredAt: at(120) });
  const moon = aMeta('seed-moon', { label: 'SEED Moon Dog', leaderName: 'SEED Moon coin', leaderSymbol: 'SEEDMOON', cap: 240_000, creators: 4, enteredAt: at(90) });
  const computedAt = at(5);
  const runId = saveCurrentRun(store, computedAt, { metas: [chair, lobster], watching: [cloud, moon] });
  counts.meta_runs += 1;
  const eventAt = at(40);
  const raised = store.meta.saveNewMeta({
    key: chair.key,
    label: chair.label,
    raisedAt: eventAt,
    reason: 'became a Meta: $SEEDCHAIR at $2.4M, 14 creators in 24 h',
    rank: 1,
    leader: { mint: chair.leader.mint, name: chair.leader.name, symbol: chair.leader.symbol, marketCapUsd: chair.leader.marketCapUsd },
    copies: 14,
    runId,
  });
  if (raised) counts.new_meta_events += 1;

  // A Meta meme trio (snapshot version 2); the second idea is the hostile one (markup in the name, a long unbroken ticker).
  const metaTrio = store.createMemeProposals(
    {
      metaKey: chair.key,
      metaLabel: chair.label,
      snapshot: {
        version: 2,
        capturedAt: at(40),
        meta: { key: chair.key, label: chair.label, enteredAt: chair.enteredAt, holding: false, counts: chair.counts, topTokens: chair.topTokens },
        leader: { mint: chair.leader.mint, name: chair.leader.name, symbol: chair.leader.symbol, marketCapUsd: chair.leader.marketCapUsd },
        trigger: { kind: 'new-meta', reason: '$SEEDCHAIR at $2.4M, 14 creators in 24 h', at: eventAt },
        run: { id: runId, computedAt },
        roomLeft: { passed: true, text: 'SEED sample: still has room' },
        tokens: chair.topTokens.map((t) => ({ ...t, migrated: false })),
        news: [{ title: 'SEED headline: the chair stays empty', sourceLabel: 'SEED Wire', url: 'https://seed.example/chair', publishedAt: at(120) }],
      },
      reason: 'New Meta: $SEEDCHAIR at $2.4M, 14 creators in 24 h',
      summary: 'SEED Empty Chair: 14 creators, 28 tokens in 24 h.',
      evidenceLinks: ['https://seed.example/chair'],
      ideas: [idea('SEED Empty Chair Inu', 'SEEDEC', 'SEED sample: the chair is the joke.'), idea(HOSTILE_NAME, HOSTILE_TICKER, `SEED sample ${'Y'.repeat(150)} hostile angle`), idea('SEED Spotlight Chair', 'SEEDSP', 'SEED sample: the spotlight is the joke.')],
    },
    { now: new Date(now.getTime() - 35 * MIN) },
  );
  counts.proposals += metaTrio.length;

  // Two news Narratives: one gets a Tech Proposal, the other fails the buildability gate and gets a news meme trio (snapshot version 3).
  store.recordSourcePoll({ sourceId: 'rss:seed', label: 'SEED Wire' }, new Date(now.getTime() - 60 * MIN));
  counts.source_polls += 1;
  const newSignal = (id, title, summary, minutesAgo) => ({ id, sourceId: 'rss:seed', sourceLabel: 'SEED Wire', title, summary, url: `https://seed.example/${id}`, publishedAt: at(minutesAgo) });
  counts.signals += store.recordSignals(
    [newSignal('seed:tech', 'SEED Startup ships a tiny invoice tool', 'SEED sample: a small app with a clear job.', 90), newSignal('seed:news', 'SEED Chipmaker beats the quarter', 'SEED sample: revenue is up and the guidance is higher.', 45)],
    new Date(now.getTime() - 30 * MIN),
  );
  const nextNarrative = (centroid) => {
    counts.narratives += 1;
    return store.createNarrative(store.unclusteredSignals(5)[0], centroid, at(60), { id: 'seed', dimension: 2 });
  };

  const techNarrative = nextNarrative([1, 0]);
  const techScore = store.recordScore({ narrativeId: techNarrative, rubricVersion: 1, scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, total: 7, rationale: 'SEED sample: a small app fits the story.', signalCount: 1, changedMateriallyAt: at(60), createdAt: at(60) });
  counts.scores += 1;
  const tech = store.createResearchProposal(
    {
      narrativeSummary: 'SEED sample narrative: a startup ships a tiny invoice tool.',
      techOneLiner: 'SEED sample Tech: a one-page invoice maker on a Worker.',
      whyNow: 'SEED sample: the story is moving today.',
      name: 'SEED Invoice Tool',
      ticker: 'SEEDINV',
      description: 'SEED sample description.',
      evidenceLinks: ['https://seed.example/seed:tech', 'https://seed.example/1', 'https://seed.example/2'],
      narrativeId: techNarrative,
      scoreId: techScore,
    },
    { now: new Date(now.getTime() - 55 * MIN) },
  );
  counts.proposals += 1;

  const newsNarrative = nextNarrative([0, 1]);
  const gateMin = 5;
  const failing = { momentum: 9, novelty: 6, buildability: 3, hook: 8, legitimacy: 6 };
  const newsScore = store.recordScore({ narrativeId: newsNarrative, rubricVersion: 1, scores: failing, total: 6.4, rationale: 'SEED sample: funny and moving, but there is no small app in it.', signalCount: 1, changedMateriallyAt: at(20), createdAt: at(20) });
  counts.scores += 1;
  const newsTrio = store.createMemeProposals(
    {
      narrative: { id: newsNarrative, scoreId: newsScore },
      metaKey: `narrative:${newsNarrative}`,
      metaLabel: 'SEED Chipmaker beats the quarter',
      snapshot: {
        version: 3,
        kind: 'narrative',
        capturedAt: at(15),
        narrative: { id: newsNarrative, title: 'SEED Chipmaker beats the quarter', summary: 'SEED sample: revenue is up and the guidance is higher.', signalCount: 1, createdAt: at(60), lastSignalAt: at(45) },
        score: { id: newsScore, rubricVersion: 1, total: 6.4, scores: failing, rationale: 'SEED sample: funny and moving, but there is no small app in it.', gateMin, createdAt: at(20) },
        trigger: { kind: 'news-meme', reason: `buildability 3 under the gate of ${gateMin}; legitimacy 6, hook 8, momentum 9`, at: at(20) },
        news: [{ title: 'SEED Chipmaker beats the quarter', sourceLabel: 'SEED Wire', url: 'https://seed.example/seed:news', publishedAt: at(45) }],
      },
      reason: `News meme: buildability 3 under the gate of ${gateMin}; legitimacy 6, hook 8, momentum 9`,
      summary: 'From news: SEED Chipmaker beats the quarter. Buildability 3 under the gate of 5, so no Tech.',
      evidenceLinks: ['https://seed.example/seed:news'],
      ideas: [idea('SEED Quarter Beat Coin', 'SEEDQB', 'SEED sample: beat the quarter, beat the market.'), idea('SEED Guidance Goblin', 'SEEDGG', 'SEED sample: the guidance is higher.'), idea('SEED Revenue Frog', 'SEEDRF', 'SEED sample: revenue up, frog up.')],
    },
    { now: new Date(now.getTime() - 15 * MIN) },
  );
  counts.proposals += newsTrio.length;

  return { ids: { tech: tech.id, metaMeme: metaTrio[0].id, newsMeme: newsTrio[0].id, hostile: metaTrio[1].id }, counts };
}
