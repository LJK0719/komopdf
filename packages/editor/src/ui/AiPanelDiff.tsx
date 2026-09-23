import React from 'react';

export type DiffOp = {
  type: 'same' | 'added' | 'removed';
  text: string;
};

/**
 * 将文本切分为用于差异比较的 token 序列（兼容中英文、数字与空白）。
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  // 匹配连续汉字/字符，或英文单词，或空白，或标点
  const matches = text.match(/[一-龥]|\w+|\s+|[^\w\s一-龥]/g);
  return matches ?? [text];
}

/**
 * 计算原文本与建议文本的词/字符级别差异。
 */
export function computeTextDiff(original: string, suggested: string): DiffOp[] {
  if (original === suggested) {
    return original ? [{ type: 'same', text: original }] : [];
  }
  if (!original) {
    return suggested ? [{ type: 'added', text: suggested }] : [];
  }
  if (!suggested) {
    return original ? [{ type: 'removed', text: original }] : [];
  }

  const s1 = tokenize(original);
  const s2 = tokenize(suggested);
  const n = s1.length;
  const m = s2.length;

  // 限制过大时的计算预算（超过 1000 tokens 时按块比对以防耗时）
  if (n * m > 400_000) {
    return [
      { type: 'removed', text: original },
      { type: 'added', text: suggested },
    ];
  }

  // 动态规划计算 LCS 矩阵
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (s1[i] === s2[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // 回溯构建 diff
  const rawOps: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && s1[i - 1] === s2[j - 1]) {
      rawOps.push({ type: 'same', text: s1[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      rawOps.push({ type: 'added', text: s2[j - 1]! });
      j--;
    } else if (i > 0) {
      rawOps.push({ type: 'removed', text: s1[i - 1]! });
      i--;
    }
  }
  rawOps.reverse();

  // 合并相邻相同类型的操作
  const merged: DiffOp[] = [];
  for (const op of rawOps) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) {
      last.text += op.text;
    } else {
      merged.push({ ...op });
    }
  }

  return merged;
}

export type AiPanelDiffProps = {
  original: string;
  suggested: string;
  showStats?: boolean;
};

export function AiPanelDiff({ original, suggested, showStats = true }: AiPanelDiffProps) {
  const ops = computeTextDiff(original, suggested);
  const origLen = Array.from(original).length;
  const suggLen = Array.from(suggested).length;
  const diffChars = suggLen - origLen;

  return (
    <div className="ai-diff-container">
      <div className="ai-diff-body" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: '11px' }}>
        {ops.map((op, idx) => {
          if (op.type === 'removed') {
            return (
              <del
                key={idx}
                className="ai-diff-removed"
                style={{
                  backgroundColor: '#ffe0d8',
                  color: '#b3260a',
                  textDecoration: 'line-through',
                  padding: '1px 2px',
                  borderRadius: '2px',
                }}
              >
                {op.text}
              </del>
            );
          }
          if (op.type === 'added') {
            return (
              <ins
                key={idx}
                className="ai-diff-added"
                style={{
                  backgroundColor: '#e3efaa',
                  color: '#445b0a',
                  textDecoration: 'none',
                  fontWeight: 600,
                  padding: '1px 2px',
                  borderRadius: '2px',
                }}
              >
                {op.text}
              </ins>
            );
          }
          return <span key={idx}>{op.text}</span>;
        })}
      </div>
      {showStats && (
        <div className="ai-diff-stats" style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
          <span>Original {origLen} chars → Suggested {suggLen} chars </span>
          <span style={{ fontWeight: 600, color: diffChars < 0 ? '#445b0a' : diffChars > 0 ? '#b3260a' : '#666' }}>
            ({diffChars > 0 ? `+${diffChars}` : diffChars} chars
            {origLen > 0 ? `, ${((diffChars / origLen) * 100).toFixed(1)}%` : ''})
          </span>
        </div>
      )}
    </div>
  );
}
