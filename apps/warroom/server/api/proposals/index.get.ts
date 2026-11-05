import { withResume } from "../../utils/resume.ts";

export default defineEventHandler(() => {
  const dataDir = useDataDir();
  const buildRoot = useBuildRoot();
  return useStore().listProposals().map((p) => withResume(p, dataDir, buildRoot));
});
