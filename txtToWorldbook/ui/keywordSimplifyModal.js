/**
 * 关键词精简弹窗
 *
 * 让用户勾选要处理的分类，展示预计条目数，执行后给出结果摘要。
 */

export function createKeywordSimplifyModal(deps = {}) {
    const {
        AppState,
        ModalFactory,
        keywordSimplifyService,
        updateWorldbookPreview,
        refreshWorldbookViewModal,
        ErrorHandler,
        confirmAction,
    } = deps;

    /**
     * 打开关键词精简弹窗
     * @param {Function} [onDone] 完成后的回调，用于刷新调用方的视图
     */
    function showKeywordSimplifyModal(onDone) {
        const categories = keywordSimplifyService.scanCategories();

        if (categories.length === 0) {
            ErrorHandler.showUserError('当前世界书没有带关键词的条目');
            return;
        }

        const rows = categories
            .map(
                (c) => `
        <label class="ttw-merge-option" style="margin-bottom:8px;">
            <input type="checkbox" class="ttw-ks-cat" value="${escapeAttr(c.name)}" checked>
            <div>
                <div style="font-weight:bold;">${escapeHtml(c.name)}</div>
                <div style="font-size:11px;color:#888;">${c.entryCount} 个条目，共 ${c.keywordCount} 个关键词（平均 ${(c.keywordCount / c.entryCount).toFixed(1)} 个/条）</div>
            </div>
        </label>`,
            )
            .join('');

        const bodyHtml = `
        <div style="margin-bottom:12px;padding:10px;background:rgba(52,152,219,0.15);border-radius:6px;font-size:12px;color:#3498db;line-height:1.6;">
            把关键词交给 AI 去芜存菁，<strong>只保留能直接指代该条目的称呼</strong>——
            角色保留名字、简称、外号；删掉外貌、身份、性格、关系这类描述性的词。
            <div style="margin-top:6px;color:#888;">
                描述性关键词不但触发不准，还容易造成误触发。
            </div>
        </div>
        <div style="margin-bottom:10px;font-size:12px;color:#aaa;">选择要精简的分类：</div>
        ${rows}
        <div style="margin-top:12px;padding:10px;background:rgba(230,126,34,0.12);border-radius:6px;font-size:11px;color:#e67e22;line-height:1.6;">
            ⚠️ 这会消耗 API 调用（每 25 个条目一次请求）。
            执行前会自动存快照，结果不满意可在「📜 修改历史」里回退。
            AI 返回异常时该条目保持原样，不会把关键词弄丢。
        </div>
        <div id="ttw-ks-progress" style="display:none;margin-top:12px;">
            <div style="font-size:12px;color:#3498db;" id="ttw-ks-progress-text">准备中...</div>
            <div style="height:6px;background:rgba(255,255,255,0.1);border-radius:3px;margin-top:6px;overflow:hidden;">
                <div id="ttw-ks-progress-fill" style="height:100%;width:0%;background:#3498db;transition:width 0.3s;"></div>
            </div>
        </div>`;

        const footerHtml = `
            <button class="ttw-btn" id="ttw-ks-cancel">取消</button>
            <button class="ttw-btn ttw-btn-primary" id="ttw-ks-start">🔤 开始精简</button>`;

        const modal = ModalFactory.create({
            id: 'ttw-keyword-simplify-modal',
            title: '🔤 精简世界书关键词',
            body: bodyHtml,
            footer: footerHtml,
            maxWidth: '560px',
        });

        const close = () => ModalFactory.close(modal);
        modal.querySelector('#ttw-ks-cancel').addEventListener('click', close);

        modal.querySelector('#ttw-ks-start').addEventListener('click', async () => {
            const checked = [...modal.querySelectorAll('.ttw-ks-cat:checked')].map((el) => el.value);
            if (checked.length === 0) {
                ErrorHandler.showUserError('请至少选择一个分类');
                return;
            }

            const totalEntries = categories
                .filter((c) => checked.includes(c.name))
                .reduce((sum, c) => sum + c.entryCount, 0);

            const go = await confirmAction(
                `将对 ${checked.length} 个分类、共 ${totalEntries} 个条目执行关键词精简。\n\n` +
                    `预计 ${Math.ceil(totalEntries / 25)} 次 API 请求。确定开始吗？`,
                { title: '精简关键词' },
            );
            if (!go) return;

            const startBtn = modal.querySelector('#ttw-ks-start');
            const cancelBtn = modal.querySelector('#ttw-ks-cancel');
            startBtn.disabled = true;
            startBtn.textContent = '处理中...';
            cancelBtn.disabled = true;

            const progressBox = modal.querySelector('#ttw-ks-progress');
            const progressText = modal.querySelector('#ttw-ks-progress-text');
            const progressFill = modal.querySelector('#ttw-ks-progress-fill');
            progressBox.style.display = 'block';

            try {
                const stats = await keywordSimplifyService.simplifyCategories(checked, (done, total, cat) => {
                    const pct = Math.round((done / total) * 100);
                    progressText.textContent = `正在处理「${cat}」... ${done}/${total}`;
                    progressFill.style.width = `${pct}%`;
                });

                if (typeof updateWorldbookPreview === 'function') updateWorldbookPreview();
                if (typeof refreshWorldbookViewModal === 'function') refreshWorldbookViewModal();
                close();

                const lines = [
                    `✅ 关键词精简完成`,
                    ``,
                    `· 精简了 ${stats.simplified} 个条目`,
                    `· 共删除 ${stats.removedKeywords} 个描述性关键词`,
                    `· ${stats.unchanged} 个条目本来就很干净，保持原样`,
                ];
                if (stats.failed > 0) {
                    lines.push(`· ${stats.failed} 个条目所在批次请求失败，已保持原关键词`);
                }
                lines.push('', '不满意可在「📜 修改历史」回退到「关键词精简前」的快照。');
                ErrorHandler.showUserSuccess(lines.join('\n'));

                if (typeof onDone === 'function') onDone(stats);
            } catch (error) {
                startBtn.disabled = false;
                startBtn.textContent = '🔤 开始精简';
                cancelBtn.disabled = false;
                progressBox.style.display = 'none';
                ErrorHandler.showUserError('关键词精简失败: ' + error.message);
            }
        });
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
    function escapeAttr(text) {
        return escapeHtml(text).replace(/"/g, '&quot;');
    }

    return { showKeywordSimplifyModal };
}
