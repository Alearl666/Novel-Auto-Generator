import { t } from './i18n.js';

export function createErrorHandler(deps = {}) {
    const { Logger, ModalFactory, confirmAction } = deps;

    return {
        handle(error, context = '') {
            Logger.error(context || 'App', error.message || error);

            if (error.message === 'ABORTED') {
                return { handled: true, message: t('errors.operationCancelled') };
            }

            if (error.message?.startsWith('TOKEN_LIMIT:')) {
                return { handled: true, message: t('errors.tokenLimit'), isTokenLimit: true };
            }

            if (error.status || error.message?.includes('API') || error.message?.includes('请求')) {
                return this.handleAPIError(error);
            }

            if (
                error.message?.includes('network') ||
                error.message?.includes('网络') ||
                error.message?.includes('fetch')
            ) {
                this.showUserError(t('errors.network'));
                return { handled: true, message: t('errors.networkError') };
            }

            this.showUserError(error.message || t('errors.unknown'));
            return { handled: false, message: error.message || t('errors.unknown') };
        },

        handleAPIError(error) {
            const status = error.status || this.extractStatus(error.message);
            const httpMsg = status ? t(`errors.http.${status}`) : null;
            const msg =
                (httpMsg && httpMsg !== `errors.http.${status}` ? httpMsg : null) ||
                error.message ||
                t('errors.apiError', { status: status || t('common.unknown') });
            this.showUserError(msg);
            return { handled: true, message: msg };
        },

        extractStatus(message) {
            if (!message) return null;
            const match = message.match(/\b(\d{3})\b/);
            return match ? parseInt(match[1], 10) : null;
        },

        showUserError(message) {
            const bodyNode = document.createElement('div');
            bodyNode.style.cssText =
                'white-space: pre-wrap; word-wrap: break-word; font-family: monospace; color: #ff6b6b; padding: 10px;';
            bodyNode.textContent = String(message ?? t('errors.unknown'));

            const footerNode = document.createElement('button');
            footerNode.className = 'ttw-btn ttw-btn-primary';
            footerNode.id = 'ttw-close-error-modal';
            footerNode.type = 'button';
            footerNode.textContent = t('help.gotIt');

            const modal = ModalFactory.create({
                id: 'ttw-error-modal',
                title: t('modal.error'),
                bodyNode,
                footerNode,
                maxWidth: '500px',
            });
            modal.querySelector('#ttw-close-error-modal').addEventListener('click', () => ModalFactory.close(modal));
        },

        showUserSuccess(message) {
            const existingToast = document.getElementById('ttw-success-toast');
            if (existingToast) existingToast.remove();

            const toast = document.createElement('div');
            toast.id = 'ttw-success-toast';
            toast.style.cssText = `
position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
padding: 12px 24px; background: #27ae60; color: #fff;
border-radius: 8px; z-index: 999999; font-size: 14px;
box-shadow: 0 4px 12px rgba(0,0,0,0.3);
animation: ttw-toast-in 0.3s ease;
`;
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.style.animation = 'ttw-toast-out 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }, 2000);
        },

        confirmAsync(message, title) {
            return confirmAction(message, { title: title || t('modal.confirmTitle') });
        },
    };
}
