import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const contributes = pkg.contributes;

describe('package.json manifest', () => {
  describe('activity bar container (Req 1.1, 1.2, 1.3)', () => {
    it('contributes exactly one activitybar container with expected id, title, icon and no when', () => {
      const containers = contributes.viewsContainers.activitybar;
      expect(containers).toHaveLength(1);
      const [container] = containers;
      expect(container.id).toBe('goget-manager');
      expect(container.title).toBe('Goget Manager');
      expect(container.icon).toBe('imgs/goget-manager-activitybar.png');
      expect(container).not.toHaveProperty('when');
    });

    it('icon file exists on disk', () => {
      expect(existsSync(resolve(root, 'imgs', 'goget-manager-activitybar.png'))).toBe(true);
    });

    it('keeps the extension-level icon', () => {
      expect(pkg.icon).toBe('imgs/goget-manager-icon.png');
      expect(existsSync(resolve(root, 'imgs', 'goget-manager-icon.png'))).toBe(true);
    });
  });

  describe('views (Req 1.6, 1.8, 2.1, 2.2, 2.3, 2.5)', () => {
    const views = contributes.views['goget-manager'];

    it('declares Search (webview) then Installed, in that order', () => {
      expect(views).toHaveLength(2);
      expect(views[0]).toMatchObject({
        id: 'gogetManager.search',
        name: 'Search',
        type: 'webview',
      });
      expect(views[1]).toMatchObject({
        id: 'gogetManager.installed',
        name: 'Installed',
      });
      expect(views[1].type).not.toBe('webview');
    });

    it('does not collapse either view by default', () => {
      for (const view of views) {
        expect(view.visibility).not.toBe('collapsed');
      }
    });
  });

  describe('refresh command (Req 6.3)', () => {
    it('declares the refresh command', () => {
      const cmd = contributes.commands.find(
        (c: { command: string }) => c.command === 'gogetManager.refresh',
      );
      expect(cmd).toBeDefined();
      expect(cmd.title).toBe('Refresh');
      expect(cmd.icon).toBe('$(refresh)');
      expect(cmd.category).toBe('Goget Manager');
    });

    it('binds refresh to the Installed view title bar', () => {
      const entries = contributes.menus['view/title'].filter(
        (m: { command: string }) => m.command === 'gogetManager.refresh',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].when).toBe('view == gogetManager.installed');
      expect(entries[0].group).toBe('navigation');
    });
  });
});
