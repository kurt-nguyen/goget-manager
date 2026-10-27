/**
 * Pure HTML builder for the package detail webview. Intentionally free of any
 * `vscode` usage so it can be unit tested directly.
 */
export function buildDetailHtml(
  cspSource: string,
  nonce: string,
  cssUri: string,
  jsUri: string,
): string {
  const csp = `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src https: data: ${cspSource}; font-src ${cspSource}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>Package details</title>
</head>
<body>
  <div id="detail-root">
    <div id="detail-status" role="status" aria-live="polite"></div>
    <div id="detail-error" role="alert" hidden></div>
    <header id="detail-header"></header>
    <main id="detail-main"></main>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
