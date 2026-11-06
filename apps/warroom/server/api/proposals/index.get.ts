import { withResume } from "../../utils/resume.ts";
import { withScore } from "../../utils/score.ts";

export default defineEventHandler(() => {
  const dataDir = useDataDir();
  const buildRoot = useBuildRoot();
  const store = useStore();
  return store.listProposals().map((p) => withScore(store, withResume(p, dataDir, buildRoot)));
});
