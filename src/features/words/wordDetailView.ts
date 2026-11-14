import type { Word } from '../../types';
import { editWord, setMastery } from './wordStore';
import { escapeHtml } from './html';
import { masteryZh } from './mastery';

export interface DetailHandlers {
  onBack: () => void;
  onChanged: () => void;
}

export function mountWordDetailView(root: HTMLElement, word: Word, handlers: DetailHandlers): void {
  root.innerHTML = `
    <div class="wdetail">
      <button class="wback" type="button">← 返回词本</button>
      <div class="wdetail-head">
        <span class="hw">${escapeHtml(word.headword)}</span>
        ${word.pos ? `<span class="pos">${escapeHtml(word.pos)}</span>` : ''}
        <span class="badge ${word.mastery}">${masteryZh[word.mastery]}</span>
      </div>
      <p class="wdetail-meaning">${escapeHtml(word.meaningZh)}</p>

      <h4 class="wdetail-section">搭配</h4>
      ${
        word.collocations.length === 0
          ? '<p class="wdetail-empty">还没有搭配，先补一条最常用的。</p>'
          : `<ul class="wcoll">${word.collocations
              .map(
                (c) => `
            <li><span class="phrase">${escapeHtml(c.phrase)}</span><span class="gloss">${escapeHtml(c.gloss)}</span></li>`,
              )
              .join('')}</ul>`
      }
      <form class="wadd-coll" novalidate>
        <input name="phrase" type="text" placeholder="搭配，如 mitigate risk" autocomplete="off" />
        <input name="gloss" type="text" placeholder="中文，如 降低风险" autocomplete="off" />
        <button type="submit">加搭配</button>
      </form>

      <h4 class="wdetail-section">例句</h4>
      ${
        word.examples.length === 0
          ? '<p class="wdetail-empty">还没有例句，自己造一句更容易记住。</p>'
          : `<ul class="wexamples">${word.examples
              .map((e) => `<li>${escapeHtml(e)}</li>`)
              .join('')}</ul>`
      }
      <form class="wadd-example" novalidate>
        <input name="example" type="text" placeholder="例句，如 The city mitigated the risk of flooding." autocomplete="off" />
        <button type="submit">加例句</button>
      </form>

      <div class="wdetail-actions">
        ${
          word.mastery === 'training'
            ? '<p class="wdetail-flag">已在练用中，写作时用它，反馈会把它推进到「会用」。</p>'
            : `<button class="wtrain" type="button">标记为练用中</button>`
        }
      </div>
      <p class="wdetail-meta">来源：${escapeHtml(word.source ?? '手动收录')} · 更新于 ${new Date(
        word.updatedAt,
      ).toLocaleString()}</p>
    </div>`;

  root.querySelector<HTMLButtonElement>('.wback')!.addEventListener('click', handlers.onBack);

  const collForm = root.querySelector<HTMLFormElement>('.wadd-coll')!;
  collForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(collForm);
    const phrase = String(data.get('phrase') ?? '').trim();
    const gloss = String(data.get('gloss') ?? '').trim();
    if (phrase === '') return;
    editWord(word.id, { collocations: [...word.collocations, { phrase, gloss }] });
    handlers.onChanged();
  });

  const exampleForm = root.querySelector<HTMLFormElement>('.wadd-example')!;
  exampleForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const example = String(new FormData(exampleForm).get('example') ?? '').trim();
    if (example === '') return;
    editWord(word.id, { examples: [...word.examples, example] });
    handlers.onChanged();
  });

  root.querySelector<HTMLButtonElement>('.wtrain')?.addEventListener('click', () => {
    setMastery(word.id, 'training');
    handlers.onChanged();
  });
}
