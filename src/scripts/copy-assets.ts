import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const source = resolve(__dirname, "../../../src/gui");
const destination = resolve(__dirname, "../gui");

mkdirSync(destination, { recursive: true });
for (const file of ["index.html", "styles.css"]) {
  copyFileSync(join(source, file), join(destination, file));
}
