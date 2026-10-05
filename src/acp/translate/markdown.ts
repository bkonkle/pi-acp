export function codeBlock(text: string, language = ''): string {
  const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)))
  return `${fence}${language}\n${text}\n${fence}`
}

export function inlineCode(text: string): string {
  const fence = '`'.repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)))
  return `${fence} ${text.replace(/\s+/g, ' ')} ${fence}`
}
