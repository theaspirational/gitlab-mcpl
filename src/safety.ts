/** Neutralise ALL command-looking lines, including unknown/future quick actions.
 * GitLab deletes every CR before extraction; normalize before inserting guards.
 * Apply at the HTTP boundary too: rollback and channel publication are writes. */
export function neutralize(text: string): string { return text.replace(/\r/g, '').replace(/^(\s*)\/(?=\w)/gm, '$1/\u200b'); }
export function safeText(value: unknown): unknown {
    if (typeof value === 'string')
        return neutralize(value);
    if (Array.isArray(value))
        return value.map(safeText);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeText(v)]));
    return value;
}
export function rejectMergeKeys(value: unknown): void {
    if (!value || typeof value !== 'object')
        return;
    for (const [k, v] of Object.entries(value)) {
        if (/(?:auto_?merge|merge_when|merge_ref|cancel_merge|skip_ci|state_event|squash)/i.test(k))
            throw new Error(`Forbidden request field: ${k}`);
        rejectMergeKeys(v);
    }
}
export function bound(text: string, bytes: number, tail = false): string {
    const b = Buffer.from(text);
    if (b.length <= bytes)
        return text;
    // Decode complete UTF-8 characters only; limits are bytes, not UTF-16 units.
    let out = b.subarray(tail ? b.length - bytes : 0, tail ? undefined : bytes).toString('utf8');
    if (tail)
        out = out.replace(/^\uFFFD+/, '');
    else
        out = out.replace(/\uFFFD+$/, '');
    return out;
}
