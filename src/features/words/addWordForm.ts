import { addWord, loadWords } from './wordStore';

export function mountAddWordForm(root: HTMLElement, onAdded: (headword: string) => void): void {
  root.innerHTML = `
    <form class="wform" novalidate>
      <h3 class="wform-title">手动收词</h3>
      <div class="wform-grid">
        <label class="wfield" for="wb-headword">
          英文词头
          <input class="wb-input" id="wb-headword" name="headword" type="text" placeholder="如 mitigate" autocomplete="off" />
        </label>
        <label class="wfield" for="wb-meaning">
          中文释义
          <input class="wb-input" id="wb-meaning" name="meaningZh" type="text" placeholder="如 减轻、缓和" autocomplete="off" />
        </label>
        <label class="wfield" for="wb-source">
          来源（可选）
          <input class="wb-input" id="wb-source" name="source" type="text" autocomplete="off" />
        </label>
        <button class="btn btn--sm btn--primary" type="submit">收入词本</button>
      </div>
      <p class="wform-hint" role="status"></p>
    </form>`;

  const form = root.querySelector<HTMLFormElement>('form')!;
  const hint = root.querySelector<HTMLParagraphElement>('.wform-hint')!;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const headword = String(data.get('headword') ?? '').trim();
    const meaningZh = String(data.get('meaningZh') ?? '').trim();
    const source = String(data.get('source') ?? '').trim();

    if (headword === '' || meaningZh === '') {
      hint.textContent = '词头和中文释义都要填。';
      return;
    }

    const dup = loadWords().some((w) => w.headword.toLowerCase() === headword.toLowerCase());
    if (dup) {
      hint.textContent = `「${headword}」已经在词本里了。`;
      return;
    }

    addWord({ headword, meaningZh, source: source === '' ? undefined : source });
    form.reset();
    hint.textContent = `已收录「${headword}」，刷新后仍在词本里。`;
    onAdded(headword);
  });
}
