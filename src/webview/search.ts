import { clampSearchText } from '../core/searchText';

interface SearchViewState {
  text: string;
}

interface WebviewApi {
  getState(): SearchViewState | undefined;
  setState(state: SearchViewState): void;
}

declare function acquireVsCodeApi(): WebviewApi;

// Search_Box script. It only persists the text through the webview state API
// and suppresses the default Enter behavior. It never posts messages, so the
// extension host does no work in response to search input.
(function main(): void {
  const vscode = acquireVsCodeApi();
  const input = document.getElementById('search') as HTMLInputElement | null;
  if (!input) {
    return;
  }

  const saved = vscode.getState();
  input.value = saved?.text ?? '';

  input.addEventListener('input', () => {
    vscode.setState({ text: clampSearchText(input.value) });
  });

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
    }
  });
})();
