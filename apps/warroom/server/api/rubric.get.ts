/** The current Rubric (the editor's starting point) and the version numbers kept. */
export default defineEventHandler(() => ({ ...useStore().getRubric(), versions: useStore().listRubricVersions() }));
