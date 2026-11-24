// Run one local video through the pipeline and print the result.
//   node src/cli.ts path/to/video.mp4
import { resolve } from "node:path";
import { config } from "./config.ts";
import { runCheck } from "./pipeline.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node src/cli.ts <video-file>");
  process.exit(2);
}
const result = await runCheck(
  { videoUrl: `file://${resolve(file)}` },
  config,
  { localFile: resolve(file), log: (m) => console.error(`· ${m}`) },
);
console.log(JSON.stringify(result, null, 2));
