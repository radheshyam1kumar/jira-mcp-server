/**
 * @param {string} url
 * @returns {string|null}
 */
export function extractGoogleDocId(url) {
  const match = typeof url === 'string' ? url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) : null;
  return match ? match[1] : null;
}

/**
 * Recursively extract plain text from Google Docs API document body (paragraphs + tables).
 *
 * @param {unknown[]|undefined} elements
 * @returns {string}
 */
export function extractTextFromDocumentContent(elements) {
  if (!Array.isArray(elements)) {
    return '';
  }

  let text = '';

  for (const el of elements) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements || []) {
        if (pe.textRun?.content) {
          text += pe.textRun.content;
        }
      }
      text += '\n';
    } else if (el.table && el.table.tableRows) {
      for (const row of el.table.tableRows) {
        const cells = row.tableCells || [];
        for (const cell of cells) {
          text += extractTextFromDocumentContent(cell.content);
          text += '\t';
        }
        text += '\n';
      }
    } else if (el.tableOfContents?.content) {
      text += extractTextFromDocumentContent(el.tableOfContents.content);
    }
  }

  return text;
}
