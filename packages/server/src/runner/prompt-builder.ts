export interface BuildPromptInput {
  userPrompt: string;
  workspaceMount: string;
}

const TEMPLATE = `你的工作目录是 {{WORKSPACE_MOUNT}}。这是一个真实的项目目录,可能是 git 仓库。

## 当前任务
{{USER_PROMPT}}

## 工作流程建议
1. 用 bash 探索当前目录结构 (\`ls -la\`)
2. 根据需要修改文件 (用 read/write/edit 工具)
3. 完成后用 \`git add -A && git commit -m "..."\` 记录改动
4. 在最后的回复中总结做了什么、改了哪些文件

## 安全提示
- 不要执行破坏性命令 (\`rm -rf /\`、\`dd\`、格式化等),除非用户明确要求
- 遇到权限错误、缺失依赖、网络失败等情况,直接报告而不是尝试绕过
- 修改前先看清现有代码,不要假设文件结构
`;

function escapeCodeFence(text: string): string {
  return text.replace(/```/g, '` ` `');
}

export function buildPiPrompt(input: BuildPromptInput): string {
  const safePrompt = escapeCodeFence(input.userPrompt);
  return TEMPLATE.replace('{{WORKSPACE_MOUNT}}', input.workspaceMount).replace(
    '{{USER_PROMPT}}',
    safePrompt,
  );
}
