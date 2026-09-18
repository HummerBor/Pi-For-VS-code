// bump 版本：PI_VER 显式指定（如 0.1.0），否则 patch 自增（package/release/ship 共用）
// 09-18 用户要求：下次 ship 以 0.1.0 发——`PI_VER=0.1.0 npm run ship`
import { execSync } from "node:child_process";
const v = process.env.PI_VER;
execSync(`npm version ${v ? `"${v}"` : "patch"} --no-git-tag-version`, { stdio: "inherit" });
