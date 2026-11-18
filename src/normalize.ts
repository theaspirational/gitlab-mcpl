/** GitLab to-dos remain authoritative for user and group mentions. This is
 * only the comment-body fallback, excluding fenced, indented and inline code. */
export function mentionsUser(body: string, username: string): boolean {
    let fence: {
        char: string;
        length: number;
    } | undefined;
    const prose: string[] = [];
    for (const line of body.split(/\r?\n/)) {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence) {
            if (marker && marker[0] === fence.char && marker.length >= fence.length)
                fence = undefined;
            continue;
        }
        if (marker) {
            fence = { char: marker[0], length: marker.length };
            continue;
        }
        if (/^(?: {4}|\t)/.test(line))
            continue;
        prose.push(line.replace(/(`+).*?\1/g, ''));
    }
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w])@${escaped}(?![\\w.-])`).test(prose.join('\n'));
}
