// 把前端静态资源复制到 dist/web/public，让服务器在构建产物里也能提供页面。
// 前端是手写的 HTML/CSS/JS，不需要打包或转译，只做一次复制。
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "src", "web", "public");
const target = join(packageRoot, "dist", "web", "public");

if (!existsSync(source)) {
	throw new Error(`缺少前端资源目录：${source}`);
}

// 先删掉旧的，避免删除了某个资源后 dist 里还留着。
rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });

console.log(`已复制前端资源：${source} -> ${target}`);
