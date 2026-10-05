import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thu thập tất cả các file TypeScript trong thư mục
 */
function getTsFiles(dir, base = "") {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const relPath = path.join(base, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getTsFiles(fullPath, relPath));
    } else if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

/**
 * Xây dựng đồ thị phụ thuộc (dependency graph) và phát hiện cycle
 */
export function findCircularDependencies(targetDir) {
  const allFiles = getTsFiles(targetDir);
  const graph = {};
  const fileKeySet = new Set(allFiles.map(f => f.relPath));

  for (const { fullPath, relPath } of allFiles) {
    const content = fs.readFileSync(fullPath, "utf-8");
    const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?["'](\.[^"']*)["']/g;
    let match;
    const deps = [];
    while ((match = importRegex.exec(content)) !== null) {
      const importTarget = match[1];
      const resolvedPath = path.normalize(path.join(path.dirname(relPath), importTarget));
      deps.push(resolvedPath);
    }
    graph[relPath] = deps;
  }

  // Thuật toán DFS phát hiện cycle với đệ quy và recursion stack
  const visited = {};
  const recStack = {};
  const cycles = [];

  function resolveNeighborKey(n) {
    if (fileKeySet.has(n)) return n;
    if (fileKeySet.has(`${n}.ts`)) return `${n}.ts`;
    if (fileKeySet.has(`${n}/index.ts`)) return `${n}/index.ts`;
    if (fileKeySet.has(`${n}/index`)) return `${n}/index`;
    return null;
  }

  function checkCycle(node, pathStack = []) {
    visited[node] = true;
    recStack[node] = true;
    pathStack.push(node);

    const neighbors = graph[node] || [];
    for (const n of neighbors) {
      const resolved = resolveNeighborKey(n);
      if (!resolved) continue;

      if (!visited[resolved]) {
        checkCycle(resolved, [...pathStack]);
      } else if (recStack[resolved]) {
        const cycleStartIndex = pathStack.indexOf(resolved);
        if (cycleStartIndex !== -1) {
          cycles.push([...pathStack.slice(cycleStartIndex), resolved]);
        } else {
          cycles.push([...pathStack, resolved]);
        }
      }
    }

    recStack[node] = false;
  }

  for (const node of Object.keys(graph)) {
    if (!visited[node]) {
      checkCycle(node);
    }
  }

  return { graph, cycles };
}

// Nếu chạy trực tiếp từ dòng lệnh (CLI mode)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const targetArg = process.argv[2] || "src/adapters/m365-copilot";
  const projectRoot = process.cwd();
  const targetDir = path.isAbsolute(targetArg) ? targetArg : path.join(projectRoot, targetArg);

  console.log(`[CI GATE] Kiểm tra Circular Dependency trong: ${path.relative(projectRoot, targetDir)}`);

  if (!fs.existsSync(targetDir)) {
    console.error(`[LỖI] Thư mục không tồn tại: ${targetDir}`);
    process.exit(1);
  }

  const { graph, cycles } = findCircularDependencies(targetDir);
  const totalModules = Object.keys(graph).length;

  console.log(`Đã quét ${totalModules} modules TypeScript.`);

  if (cycles.length === 0) {
    console.log(`\x1b[32m✔ THÀNH CÔNG: Không phát hiện Circular Dependency nào (0 cycles).\x1b[0m`);
    process.exit(0);
  } else {
    console.error(`\x1b[31m✖ THẤT BẠI: Phát hiện ${cycles.length} Circular Dependency:\x1b[0m`);
    cycles.forEach((c, idx) => {
      console.error(`  [Cycle #${idx + 1}] ${c.join(" ➔ ")}`);
    });
    process.exit(1);
  }
}
