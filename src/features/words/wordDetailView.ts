import type { Word } from '../../types';
import { escapeHtml } from '../../escapeHtml';
import { editWord, setMastery } from './wordStore';
import { masteryZh } from './mastery';

export interface DetailHandlers {
  onBack: () => void;
  onChanged: () => void;
}

export function mountWordDetailView(root: HTMLElement, word: Word, handlers: DetailHandlers): void {
  root.innerHTML = `
    <div class="wdetail">
      <button class="btn btn--sm btn--secondary wback" type="button">← 返回词本</button>
      <div class="wdetail-head">
        <span class="wb-hw">${escapeHtml(word.headword)}</span>
        ${word.phonetic ? `<span class="wb-ipa">${escapeHtml(word.phonetic)}</span>` : ''}
        ${word.pos ? `<span class="wb-pos">${escapeHtml(word.pos)}</span>` : ''}
        <span class="badge ${word.mastery}">${masteryZh[word.mastery]}</span>
      </div>
      <p class="wdetail-meaning${word.meaningZh ? '' : ' empty'}">${
        word.meaningZh ? escapeHtml(word.meaningZh) : '还没有中文释义。'
      }</p>

      <h3 class="wdetail-section">搭配</h3>
      ${
        word.collocations.length === 0
          ? '<p class="wdetail-empty">还没有搭配。</p>'
          : `<ul class="wcoll">${word.collocations
              .map(
                (c) => `
            <li><span class="wb-phrase">${escapeHtml(c.phrase)}</span><span class="wb-gloss">${escapeHtml(c.gloss)}</span></li>`,
              )
              .join('')}</ul>`
      }
      <form class="wadd-coll" novalidate>
        <label class="wfield" for="wb-coll-phrase">
          英文搭配
          <input class="wb-input" id="wb-coll-phrase" name="phrase" type="text" placeholder="如 mitigate risk" autocomplete="off" />
        </label>
        <label class="wfield" for="wb-coll-gloss">
          中文说法
          <input class="wb-input" id="wb-coll-gloss" name="gloss" type="text" placeholder="如 降低风险" autocomplete="off" />
        </label>
        <button class="btn btn--sm btn--primary" type="submit">加搭配</button>
      </form>

      <h3 class="wdetail-section">例句</h3>
      ${
        word.examples.length === 0
          ? '<p class="wdetail-empty">还没有例句。</p>'
          : `<ul class="wexamples">${word.examples
              .map((e) => `<li>${escapeHtml(e)}</li>`)
              .join('')}</ul>`
      }
      <form class="wadd-example" novalidate>
        <label class="wfield" for="wb-example">
          英文例句
          <input class="wb-input" id="wb-example" name="example" type="text" placeholder="如 The city mitigated the risk of flooding." autocomplete="off" />
        </label>
        <button class="btn btn--sm btn--primary" type="submit">加例句</button>
      </form>

      ${
        word.mastery === 'passive'
          ? '<div class="wdetail-actions"><button class="btn btn--sm btn--secondary wtrain" type="button">标记为练用中</button></div>'
          : ''
      }
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
