import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { GogetManagerApi } from '../../src/vscode/testApi';
import { describeTree, getApi, waitUntil } from './helpers';

/** The live search hits pkg.go.dev, so it only runs when explicitly requested. */
const liveIt = process.env.GOGET_LIVE_SEARCH === '1' ? it : it.skip;

const LIVE_SEARCH_BUDGET_MS = 15000;

describe('search view', () => {
  let api: GogetManagerApi;

  before(async () => {
    api = await getApi();
  });

  // Requirements 7.1 and 7.6: the view resolves with the empty model and no search is started
  it('resolves the Search view and starts with the empty model and no loading indicator', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.goget-manager');
    await waitUntil(() => {
      assert.ok(api.isSearchViewResolved(), 'Search view was not resolved');
    }, 5000);

    assert.deepStrictEqual(api.getSearchState(), {
      results: [],
      status: '',
      loading: false,
      resultsVersion: 0,
    });
  });

  // Requirements 1.5 and 7.1: Enter submits a search; the Installed list is unaffected
  liveIt('finds the mongo package for "mongodb" and leaves the Installed tree unchanged', async () => {
    assert.ok(api.submitSearchForTest, 'submitSearchForTest is only available in the Test extension mode');

    const before = api.getInstalledTree();
    api.submitSearchForTest('mongodb');

    await waitUntil(() => {
      const state = api.getSearchState();
      assert.ok(!state.loading, `search still running: ${state.status}`);
      assert.ok(state.results.length >= 1, `no results yet (status: "${state.status}")`);
      assert.ok(
        state.results.some((r) => r.name === 'mongo'),
        `no "mongo" package among: ${state.results.map((r) => r.path).join(', ')}`,
      );
    }, LIVE_SEARCH_BUDGET_MS);

    const after = api.getInstalledTree();
    assert.deepStrictEqual(after, before, `Installed tree changed:\n${describeTree(after)}`);
  });
});
