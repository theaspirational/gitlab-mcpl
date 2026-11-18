const eraseLine = '\x1b[0K';
const sectionOptions = ['[collapsed=true]', '[collapsed=false]', '[hide_duration=true]', '[hide_duration=false]'];

/** Only recognize the framing GitLab emits, including the trailing erase-line control.
 * Unknown options, malformed controls and overlong candidates stay literal. */
function sectionPrefix(text: string): boolean {
    for (const kind of ['start', 'end']) {
        const head = `section_${kind}:`;
        if (head.startsWith(text)) return true;
        if (!text.startsWith(head)) continue;
        const rest = text.slice(head.length);
        if (/^\d*$/.test(rest)) return true;
        const timestamp = /^\d+:/.exec(rest);
        if (!timestamp) continue;
        const body = rest.slice(timestamp[0].length);
        if (/^[A-Za-z0-9_.-]*$/.test(body)) return true;
        const name = /^[A-Za-z0-9_.-]+/.exec(body);
        if (!name) continue;
        const tail = body.slice(name[0].length);
        const options = kind === 'start' ? ['', ...sectionOptions] : [''];
        for (const option of options) {
            const ending = option + '\r' + eraseLine;
            if (ending.startsWith(tail)) return true;
        }
    }
    return false;
}

export class TraceCleaner {
    private escape = '';
    private marker = '';
    private afterErase = false;
    private lineStart = true;

    push(text: string): string {
        let out = '';
        for (const ch of text) {
            const lineStart = this.lineStart;
            this.lineStart = ch === '\n';
            // Runners may omit the leading erase-line control at a line start.
            // Match the complete raw framing before stripping its trailing CSI.
            if (this.marker || ((this.afterErase || lineStart) && ch === 's')) {
                this.afterErase = false;
                const candidate = this.marker + ch;
                if (candidate.length <= 4096 && sectionPrefix(candidate)) {
                    this.marker = candidate.endsWith('\r' + eraseLine) ? '' : candidate;
                    continue;
                }
                // Reprocess the mismatching character: it may begin a real CSI.
                out += this.marker;
                this.marker = '';
            }
            this.afterErase = false;
            if (this.escape) {
                this.escape += ch;
                const value = this.escape;
                const csi = /^(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]$/;
                const csiPrefix = /^(?:\x1b\[|\x9b)[0-?]*[ -/]*$/;
                const osc = /^(?:\x1b\]|\x9d)[^\x00-\x06\x08-\x1f\x7f-\x9f]*(?:\x07|\x1b\\|\x9c)$/;
                const oscPrefix = /^(?:\x1b\]|\x9d)[^\x00-\x06\x08-\x1f\x7f-\x9f]*\x1b?$/;
                if (csi.test(value) || osc.test(value)) {
                    this.afterErase = value === eraseLine;
                    this.escape = '';
                }
                else if (value.length > 4096 || !(csiPrefix.test(value) || oscPrefix.test(value))) {
                    out += value;
                    this.escape = '';
                }
                continue;
            }
            if (ch === '\x1b' || ch === '\x9b' || ch === '\x9d') this.escape = ch;
            else out += ch;
        }
        return out;
    }
    end(): string {
        const rest = this.marker + this.escape;
        this.marker = ''; this.escape = ''; this.afterErase = false; this.lineStart = true;
        return rest;
    }
}
export function cleanTrace(text: string): string {
    const cleaner = new TraceCleaner();
    return cleaner.push(text) + cleaner.end();
}
