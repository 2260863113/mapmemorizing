import messages from '../messages.json';

const text = messages satisfies Record<string, string>;
export type MessagesKey = keyof typeof text;

/** 读取集中文案；`{name}` 占位符用 params 替换（可重复出现）。 */
export function t(key: MessagesKey, params?: Record<string, string | number>): string {
  let s: string = text[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
