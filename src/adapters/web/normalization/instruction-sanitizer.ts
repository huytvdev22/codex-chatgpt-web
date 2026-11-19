/**
 * Bộ làm sạch boilerplate nội bộ của OpenAI Codex CLI và trích xuất metadata hữu ích
 * (như Deferred tool namespaces), dùng chung giữa tầng Normalization và Prompt Compiler.
 */

export function extractDeferredToolNamespaces(text: string): string[] {
  const results: string[] = [];
  if (!text) return results;

  const blockRegex = /Deferred tool namespaces:\s*([\s\S]*?)(?=\n<\/tools>|\n\n|\n# |$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(text)) !== null) {
    const body = match[1] || "";
    for (const line of body.split(/\r?\n/)) {
      const cleaned = line.trim().replace(/^[-*]\s*/, "").trim();
      if (cleaned && !results.includes(cleaned)) {
        results.push(cleaned);
      }
    }
  }

  return results;
}

/**
 * Loại bỏ các thẻ XML và khối instruction nội bộ của Codex CLI không phù hợp gửi thẳng
 * lên Web Chatbot, giữ lại rule dự án (AGENTS.md) và developer instructions thực chất.
 */
export function sanitizeCodexBoilerplate(text: string): string {
  let cleaned = text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<codex_apps_client_time_context>[\s\S]*?<\/codex_apps_client_time_context>/gi, "")
    .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, "")
    .replace(/<codex_apps_open_page_instructions>[\s\S]*?<\/codex_apps_open_page_instructions>/gi, "")
    .replace(/<image_resize_notice>[\s\S]*?<\/image_resize_notice>/gi, "")
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "")
    .replace(/<permissions\s+instructions>[\s\S]*?<\/permissions\s+instructions>/gi, "")
    .replace(/<permissions[\s\S]*?<\/permissions[^>]*>/gi, "")
    .replace(/<sandbox_mode[\s\S]*?<\/sandbox_mode[^>]*>/gi, "")
    .replace(/<sandbox[\s\S]*?<\/sandbox[^>]*>/gi, "")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, "")
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "")
    .replace(/<apps_instructions>[\s\S]*?<\/apps_instructions>/gi, "")
    .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/gi, "")
    .replace(/<tools>[\s\S]*?<\/tools>/gi, "")
    .replace(
      /<\/?(?:collaboration_mode|apps_instructions|plugins_instructions|tools|skills_instructions|instructions)>/gi,
      "",
    )
    .replace(/# Apps \(Connectors\)[\s\S]*?(?=\n# |\n\[|$)/gi, "")
    .replace(/# Plugins[\s\S]*?(?=\n# |\n\[|$)/gi, "")
    .replace(/Deferred tool namespaces:[\s\S]*?(?=\n# |\n\[|$)/gi, "")
    .replace(/`?\s*change it;\s*user requests or tool descriptions[\s\S]*?(?=\n# |\n<|$|\n\n)/gi, "")
    .replace(/##\s*request_user_input availability[\s\S]*?(?=\n# |\n<|$|\n\n)/gi, "")
    .replace(/In Default mode, strongly prefer making reasonable assumptions[\s\S]*?(?=\n# |\n<|$|\n\n)/gi, "")
    .replace(/Known mode names are Default and Plan\.?/gi, "")
    .replace(/(?:^|\n)\s*[-*]?\s*Use the `?request_user_input`? tool[\s\S]*?(?=\n# |\n\[|\n<|$|\n\n[A-ZÀ-Ỹ])/gi, "")
    .replace(/If `?request_user_input`? returns no answers[\s\S]*?(?=\n# |\n\[|\n<|$|\n\n[A-ZÀ-Ỹ])/gi, "")
    .replace(/Never use the `?request_user_input`? tool[\s\S]*?(?=\n# |\n\[|\n<|$|\n\n[A-ZÀ-Ỹ])/gi, "")
    .replace(/If explicit user input is required for another reason[\s\S]*?(?=\n# |\n\[|\n<|$|\n\n[A-ZÀ-Ỹ])/gi, "")
    .replace(/Never write a multiple choice question as a textual assistant message\.?/gi, "")
    .replace(/(?:^|\n)[^\n]*`?request_user_input`?[^\n]*(?:\n|$)/gi, "\n")
    .replace(/¨C[a-zA-Z0-9_-]+C/g, "")
    .trim();

  const isCodexBuiltInBoilerplate =
    cleaned.includes("You are Codex") ||
    cleaned.includes("# Rules for getting work done") ||
    cleaned.includes("# Personality\nAs Codex") ||
    cleaned.includes("Exercise caution when escaping text for execcommand calls");

  if (isCodexBuiltInBoilerplate) {
    cleaned = cleaned
      .replace(/You are Codex[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/# Personality[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/# When to ask the user for permission[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/# Autonomy and persistence[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/# Working with the user[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/# Rules for getting work done(?:\n(?:\s*[-*]|\s{2,}).*)*(?=\n# |\n\[|\n<|\n[^\s\-*]|$)/gi, "")
      .replace(/# Rules for getting work done[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .replace(/# Using skills[\s\S]*?(?=\n# |\n\[|$)/gi, "")
      .trim();
  }

  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}
