export function createLatestState() {
  return {
    articleJson: null,
    articleMarkdown: null,
    signalsJson: null,
    evidenceJsonl: null,
    briefMarkdown: null,
  };
}

export function updateLatestState(state, document, markdown, evidenceJsonl) {
  state.articleJson = `${JSON.stringify(document, null, 2)}\n`;
  state.articleMarkdown = markdown;
  state.signalsJson = `${JSON.stringify(document.signals, null, 2)}\n`;
  state.evidenceJsonl = evidenceJsonl ?? "";
  state.briefMarkdown = document.brief?.markdown ?? "";
}
