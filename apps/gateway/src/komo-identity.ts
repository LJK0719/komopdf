import type { AiRequest, AiResult } from '@pdf-editor/contracts';

export function isIdentityQuestion(instruction: string): boolean {
  return /你(?:的)?(?:实际|底层|内部|真实|使用的|是什么|是哪个|究竟是|到底是|的)?\s*(?:模型|身份|版本|系统提示词)|(?:实际|底层|内部)(?:底层|使用的)?模型(?:完整)?版本|(?:打印|泄露|输出|透露).{0,12}(?:系统提示词|内部指令)|\b(?:who are you|what model are you|your (?:actual |real |underlying |internal )?(?:model|identity|system prompt|system instructions))\b/iu.test(instruction);
}

export function identityReply(request: AiRequest): AiResult {
  return { kind: 'clarification', question: /\p{Script=Han}/u.test(request.instruction)
    ? '我是 komo，komopdf 的 PDF 助手。我不提供内部模型或配置详情，可以帮你解读文档、总结或继续追问。'
    : 'I am komo, the PDF assistant in komopdf. I do not provide internal model or configuration details. I can help you read, summarize, or discuss your PDF.' };
}

/** Only guard assistant identity claims, never document translations or cited model names. */
export function protectKomoIdentity(result: AiResult, request: AiRequest, provider: { model: string; displayName: string }): AiResult {
  if (result.kind !== 'answer' && result.kind !== 'clarification') return result;
  const text = result.kind === 'answer' ? result.text : result.question;
  for (const name of [provider.model, provider.displayName].filter(Boolean)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const claim = new RegExp(`(?:\\bI(?: am|'m)|\\bmy (?:underlying |actual |internal )?model(?: is|:)|我是|我的(?:底层|实际|内部)?模型[是为：:]?|(?:实际|底层|内部)(?:使用的)?模型(?:版本)?[：:是为])[^\\n.!?。！？]{0,80}${escaped}`, 'iu');
    if (!claim.test(text)) continue;
    const suppliedByDocument = result.kind === 'answer' && result.citations.some(citation =>
      request.context.evidence.some(evidence => evidence.id === citation.evidenceId && evidence.text.toLowerCase().includes(name.toLowerCase())));
    if (!suppliedByDocument) return identityReply(request);
  }
  return result;
}
