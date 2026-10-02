#!/usr/bin/env node

import { execSync } from "node:child_process";

/**
 * Lấy token GitHub từ git credential helper
 */
function getGitHubToken() {
  try {
    const output = execSync('echo "url=https://github.com" | git credential fill', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const match = output.match(/password=(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function fetchJSON(url, token) {
  const headers = {
    "User-Agent": "GitHub-Actions-Watcher",
    "Accept": "application/vnd.github+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

async function watch() {
  const repo = "huytvdev22/codex-chatgpt-web";
  const token = getGitHubToken();

  if (!token) {
    console.error("❌ Không lấy được GitHub token từ Git Credential Helper.");
    process.exit(1);
  }

  console.log("=================================================");
  console.log(`📡 ĐANG THEO DÕI GITHUB ACTIONS: ${repo}`);
  console.log("=================================================");

  const targetTag = "v6.2.0";
  let finished = false;
  let attempts = 0;
  const maxAttempts = 60; // Tối đa ~15 phút

  while (!finished && attempts < maxAttempts) {
    attempts++;
    try {
      const runsData = await fetchJSON(
        `https://api.github.com/repos/${repo}/actions/runs?per_page=10`,
        token
      );

      const runs = (runsData.workflow_runs || []).filter(
        r => r.id >= 36905260000 && (r.head_branch === targetTag || r.name?.includes("CI"))
      );

      if (runs.length === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] Đang chờ workflow cho tag ${targetTag} khởi chạy... (Lần ${attempts})`);
        await new Promise(r => setTimeout(r, 8000));
        continue;
      }

      console.log(`\n--- Cập nhật trạng thái [${new Date().toLocaleTimeString()}] ---`);
      let allCompleted = true;

      for (const run of runs) {
        const statusEmoji = run.status === "completed" 
          ? (run.conclusion === "success" ? "✅" : "❌") 
          : "⏳";
        console.log(`${statusEmoji} Workflow: ${run.name} (#${run.run_number})`);
        console.log(`   - Trạng thái: ${run.status} | Kết quả: ${run.conclusion || "đang chạy..."}`);
        console.log(`   - Sự kiện: ${run.event} | Nhánh/Tag: ${run.head_branch}`);
        console.log(`   - URL: ${run.html_url}`);

        // Lấy chi tiết các jobs của run
        try {
          const jobsData = await fetchJSON(run.jobs_url, token);
          if (jobsData.jobs && jobsData.jobs.length > 0) {
            for (const job of jobsData.jobs) {
              const jobEmoji = job.status === "completed"
                ? (job.conclusion === "success" ? "  ✔" : "  ✖")
                : "  ▶";
              console.log(`   ${jobEmoji} Job: ${job.name} -> ${job.status} (${job.conclusion || "đang thực hiện"})`);
              if (job.status !== "completed") {
                const currentStep = (job.steps || []).find(s => s.status === "in_progress");
                if (currentStep) {
                  console.log(`      ↳ Đang chạy bước: "${currentStep.name}"`);
                }
              }
            }
          }
        } catch {
          // Bỏ qua lỗi lấy jobs chi tiết nếu rate limit hoặc mạng chậm
        }

        if (run.status !== "completed") {
          allCompleted = false;
        }
      }

      if (allCompleted) {
        console.log("\n=================================================");
        console.log("🎉 TẤT CẢ CÁC WORKFLOW ĐÃ HOÀN THÀNH!");
        console.log("=================================================");
        finished = true;
        break;
      }

      await new Promise(r => setTimeout(r, 12000));
    } catch (err) {
      console.error(`[Lỗi] ${err.message}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

watch();
