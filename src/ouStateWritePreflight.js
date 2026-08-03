import { getProposedOuState, validateStateChange } from "./stateValidation.js";

export async function prepareOuStateWrite({
  resolveSnapshot,
  readTextFile,
  baseCommit,
  edits = [],
}) {
  const snapshot = await resolveSnapshot();
  const currentFile = await readTextFile("ou_state.json", snapshot.commit);
  const currentState = JSON.parse(currentFile.content);
  const proposedState = getProposedOuState(edits, currentState);

  const validation = validateStateChange({
    currentCommit: snapshot.commit,
    baseCommit,
    currentState,
    proposedState,
    existingPaths: snapshot.tree
      .filter((item) => item.type === "file")
      .map((item) => item.path),
    edits,
  });

  return {
    snapshot,
    validation,
  };
}
