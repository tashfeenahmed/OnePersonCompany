import { agent } from "../integrations/videoplus/stewie.ts";
import { importGameplayPreviews } from "../integrations/videoplus/gameplay-previews.ts";

try {
  const [directory, ...rest] = process.argv.slice(2);
  if (!directory || rest.length) throw new Error("Usage: npm run gameplay-previews -- /path/to/worker/backgrounds");
  const connected = agent();
  if (!connected.agent) throw new Error(connected.note);
  const clips = await importGameplayPreviews(connected.agent.url, directory);
  console.log(`Saved ${clips.length} gameplay thumbnails for the connected Workdash agent: ${clips.join(", ")}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
