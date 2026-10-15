import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { NO_GO_MOD } from '../../src/core/messages';
import type { GogetManagerApi } from '../../src/vscode/testApi';
import {
  expectSingleMessage,
  expectTopLevelRows,
  firstFolderPath,
  getApi,
  goModPathIn,
  removeFile,
  renderGoMod,
  waitForWatcherReady,
  writeFile,
} from './helpers';

describe('workspace folder without a go.mod', () => {
  let api: GogetManagerApi;
  let goModPath: string;

  before(async () => {
    api = await getApi();
    goModPath = goModPathIn(firstFolderPath());
    assert.ok(!fs.existsSync(goModPath), 'the fixture must start without a go.mod');
    await waitForWatcherReady(api, goModPath);
    removeFile(goModPath);
    await expectSingleMessage(api, NO_GO_MOD);
  });

  afterEach(() => {
    removeFile(goModPath);
  });

  // Requirement 7.2 setup for 7.8
  it('starts with the "No go.mod file found" message and no package rows', async () => {
    await expectSingleMessage(api, NO_GO_MOD);
  });

  // Requirements 6.1 and 7.8
  it('replaces the message with the new go.mod rows within 2 seconds of the file being created', async () => {
    await expectSingleMessage(api, NO_GO_MOD);

    writeFile(
      goModPath,
      renderGoMod('example.com/created', [
        ['example.com/b', 'v1.0.0'],
        ['example.com/a', 'v1.1.0'],
      ]),
    );
    await expectTopLevelRows(api, [
      ['example.com/a', 'v1.1.0'],
      ['example.com/b', 'v1.0.0'],
    ]);
  });

  // Requirements 6.5 and 7.8 (the message comes back when the file goes away)
  it('shows the "No go.mod file found" message again after the created go.mod is deleted', async () => {
    writeFile(goModPath, renderGoMod('example.com/created', [['example.com/a', 'v1.0.0']]));
    await expectTopLevelRows(api, [['example.com/a', 'v1.0.0']]);

    removeFile(goModPath);
    await expectSingleMessage(api, NO_GO_MOD);
  });
});
