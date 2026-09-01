import { AuthStore, type ProfileUpdate } from '../authStore';
import { normalize, normalizeProvince } from '../matcher';
import type { AppData, AuthUser, UserAvatar, UserHometown } from '../types';
import { t } from '../i18n';
import { $, toast } from './dom';

type AuthView = 'login' | 'register' | 'profile' | 'password';

interface LocationState {
  provinceAdcode: string;
  cityAdcode: string;
}

const MAX_AVATAR_SIZE = 20 * 1024;
const AVATAR_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#be123c', '#b45309', '#15803d', '#0369a1', '#9f1239'];

export class AuthPanel {
  private menu: HTMLElement;
  private overlay: HTMLElement;
  private card: HTMLElement;
  private location: LocationState = { provinceAdcode: '', cityAdcode: '' };
  private avatar: UserAvatar | null = null;
  private onSuccess: (() => void) | null = null;

  constructor(private store: AuthStore, private data: AppData) {
    this.menu = $('user-menu');
    this.overlay = $('auth-panel');
    this.card = $('auth-card');
    this.bindShell();
    this.store.subscribe(() => this.renderTrigger());
    this.renderTrigger();
  }

  requestLogin(onSuccess?: () => void) {
    this.onSuccess = onSuccess ?? null;
    this.closeMenu();
    this.openLogin();
  }

  private bindShell() {
    $('user-center').addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMenu();
    });
    document.addEventListener('click', () => {
      this.closeMenu();
      this.closeDropdowns();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeMenu();
        this.closeDropdowns();
        this.closeOverlay();
      }
    });
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.closeOverlay();
    });
  }

  private renderTrigger() {
    const trigger = $('user-center') as HTMLButtonElement;
    const user = this.store.currentUser();
    trigger.innerHTML = '';
    trigger.append(this.avatarEl(user, 'user-avatar'));
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = user?.username ?? t('auth.clickToLogin');
    trigger.append(name);
    this.renderMenu();
  }

  private renderMenu() {
    const user = this.store.currentUser();
    this.menu.innerHTML = '';
    this.menu.append(
      this.menuButton(t('auth.menu.profile'), () => this.openProfile(), !user),
      this.menuButton(t('auth.menu.changePassword'), () => this.openPassword(), !user),
      this.menuButton(t('auth.menu.logout'), () => this.logout(), !user),
    );
  }

  private menuButton(label: string, onClick: () => void, disabled = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (disabled) return;
      this.closeMenu();
      onClick();
    });
    return btn;
  }

  private toggleMenu() {
    const open = this.menu.classList.toggle('hidden') === false;
    ($('user-center') as HTMLButtonElement).setAttribute('aria-expanded', String(open));
    this.renderMenu();
  }

  private closeMenu() {
    this.menu.classList.add('hidden');
    ($('user-center') as HTMLButtonElement).setAttribute('aria-expanded', 'false');
  }

  private openLogin() {
    this.openOverlay('login');
  }

  private openRegister() {
    this.openOverlay('register');
  }

  private openProfile() {
    const user = this.store.currentUser();
    if (!user) {
      this.openLogin();
      return;
    }
    this.location = {
      provinceAdcode: user.hometown?.provinceAdcode ?? '',
      cityAdcode: user.hometown?.cityAdcode ?? '',
    };
    this.avatar = user.avatar;
    this.openOverlay('profile');
  }

  private openPassword() {
    if (!this.store.currentUser()) {
      this.openLogin();
      return;
    }
    this.openOverlay('password');
  }

  private openOverlay(view: AuthView) {
    this.overlay.classList.remove('hidden');
    this.renderView(view);
  }

  private closeOverlay(clearSuccess = true) {
    this.overlay.classList.add('hidden');
    if (clearSuccess) this.onSuccess = null;
  }

  private completeSuccess() {
    const onSuccess = this.onSuccess;
    this.onSuccess = null;
    onSuccess?.();
  }

  private renderView(view: AuthView) {
    if (view === 'login') this.renderLogin();
    else if (view === 'register') this.renderRegister();
    else if (view === 'password') this.renderPassword();
    else this.renderProfile();
  }

  private renderLogin() {
    this.card.innerHTML = `
      <h3>${t('auth.login.title')}</h3>
      <label class="form-row">${t('auth.login.username')}<input id="auth-login-name" type="text" autocomplete="username" /></label>
      <label class="form-row">${t('auth.login.password')}<input id="auth-login-password" type="password" autocomplete="current-password" /></label>
      <p id="auth-message" class="auth-message"></p>
      <div class="auth-switch"><button id="auth-go-register" type="button">${t('auth.login.goRegister')}</button></div>
      <div class="card-actions">
        <button id="auth-login-submit" class="primary" type="button">${t('auth.login.submit')}</button>
        <button id="auth-cancel" class="ghost" type="button">${t('auth.cancel')}</button>
      </div>
    `;
    $('auth-go-register').addEventListener('click', () => this.openRegister());
    $('auth-cancel').addEventListener('click', () => this.closeOverlay());
    $('auth-login-submit').addEventListener('click', () => this.submitLogin());
  }

  private renderRegister() {
    this.card.innerHTML = `
      <h3>${t('auth.register.title')}</h3>
      <label class="form-row">${t('auth.register.nickname')}<input id="auth-register-name" type="text" maxlength="24" autocomplete="username" /></label>
      <label class="form-row">${t('auth.register.password')}<input id="auth-register-password" type="password" autocomplete="new-password" /></label>
      <p id="auth-message" class="auth-message">${t('auth.register.hint')}</p>
      <div class="card-actions">
        <button id="auth-register-submit" class="primary" type="button">${t('auth.register.submit')}</button>
        <button id="auth-register-back" class="ghost" type="button">${t('auth.register.back')}</button>
      </div>
    `;
    $('auth-register-submit').addEventListener('click', () => this.submitRegister());
    $('auth-register-back').addEventListener('click', () => this.openLogin());
  }

  private renderProfile() {
    const user = this.store.currentUser();
    if (!user) {
      this.openLogin();
      return;
    }
    const province = this.provinceByAdcode(this.location.provinceAdcode);
    const city = this.cityByAdcode(this.location.cityAdcode);
    this.card.innerHTML = `
      <h3>${t('auth.profile.title')}</h3>
      <div class="profile-avatar-row">
        <div id="auth-avatar-preview" class="user-avatar profile-avatar"></div>
        <label class="avatar-upload">${t('auth.profile.uploadAvatar')}<input id="auth-avatar-file" type="file" accept="image/*" /></label>
      </div>
      <label class="form-row">${t('auth.profile.username')}<input id="auth-profile-name" type="text" maxlength="24" value="${escapeAttr(user.username)}" autocomplete="username" /></label>
      <div class="location-grid">
        <div class="auth-select-wrap">
          <label class="form-row">${t('auth.profile.province')}<input id="auth-profile-province" type="text" value="${escapeAttr(province?.name ?? '')}" placeholder="${t('auth.profile.provincePlaceholder')}" autocomplete="off" /></label>
          <div id="auth-province-options" class="auth-options"></div>
        </div>
        <div class="auth-select-wrap">
          <label class="form-row">${t('auth.profile.city')}<input id="auth-profile-city" type="text" value="${escapeAttr(city?.name ?? '')}" placeholder="${t('auth.profile.cityPlaceholder')}" autocomplete="off" /></label>
          <div id="auth-city-options" class="auth-options"></div>
        </div>
      </div>
      <p id="auth-message" class="auth-message"></p>
      <div class="card-actions">
        <button id="auth-profile-save" class="primary" type="button">${t('auth.profile.save')}</button>
        <button id="auth-profile-cancel" class="ghost" type="button">${t('auth.profile.cancel')}</button>
      </div>
    `;
    this.paintAvatar($('auth-avatar-preview'), { ...user, avatar: this.avatar });
    this.bindProfileInputs();
  }

  private bindProfileInputs() {
    const provinceInput = $('auth-profile-province') as HTMLInputElement;
    const cityInput = $('auth-profile-city') as HTMLInputElement;
    const avatarInput = $('auth-avatar-file') as HTMLInputElement;

    provinceInput.addEventListener('click', (event) => event.stopPropagation());
    provinceInput.addEventListener('focus', () => {
      this.openDropdown('auth-province-options');
      this.renderProvinceOptions(provinceInput.value);
    });
    provinceInput.addEventListener('input', () => {
      const province = this.matchProvince(provinceInput.value);
      if (province?.adcode !== this.location.provinceAdcode) {
        this.location.provinceAdcode = province?.adcode ?? '';
        this.location.cityAdcode = '';
        cityInput.value = '';
      }
      this.openDropdown('auth-province-options');
      this.renderProvinceOptions(provinceInput.value);
      this.renderCityOptions(cityInput.value);
    });
    cityInput.addEventListener('click', (event) => event.stopPropagation());
    cityInput.addEventListener('focus', () => {
      if (!this.location.provinceAdcode) {
        this.openDropdown('auth-city-options');
        this.renderEmptyCityOptions();
        return;
      }
      this.openDropdown('auth-city-options');
      this.renderCityOptions(cityInput.value);
    });
    cityInput.addEventListener('input', () => {
      if (!this.location.provinceAdcode) {
        this.openDropdown('auth-city-options');
        this.renderEmptyCityOptions();
        return;
      }
      const city = this.matchCity(cityInput.value);
      this.location.cityAdcode = city?.adcode ?? '';
      this.openDropdown('auth-city-options');
      this.renderCityOptions(cityInput.value);
    });
    avatarInput.addEventListener('change', () => this.readAvatar(avatarInput));
    $('auth-profile-save').addEventListener('click', () => this.submitProfile());
    $('auth-profile-cancel').addEventListener('click', () => this.closeOverlay());
  }

  /** 展开指定下拉并记录当前激活的下拉（用于点外部收起）。 */
  private openDropdown(hostId: string) {
    document.querySelectorAll<HTMLElement>('.auth-options').forEach((el) => {
      const isTarget = el.id === hostId;
      el.classList.toggle('open', isTarget);
      el.classList.toggle('hidden', !isTarget);
    });
  }

  private closeDropdowns() {
    document.querySelectorAll<HTMLElement>('.auth-options').forEach((el) => {
      el.classList.remove('open');
      el.classList.add('hidden');
    });
  }

  private renderProvinceOptions(input: string) {
    const host = $('auth-province-options');
    host.innerHTML = '';
    const rows = this.rankProvinces(input).slice(0, 8);
    for (const province of rows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = province.name;
      btn.addEventListener('click', () => {
        this.location.provinceAdcode = province.adcode;
        this.location.cityAdcode = '';
        ($('auth-profile-province') as HTMLInputElement).value = province.name;
        ($('auth-profile-city') as HTMLInputElement).value = '';
        this.closeDropdowns();
      });
      host.append(btn);
    }
  }

  private renderCityOptions(input: string) {
    const host = $('auth-city-options');
    host.innerHTML = '';
    if (!this.location.provinceAdcode) {
      this.renderEmptyCityOptions();
      return;
    }
    const rows = this.rankCities(input).slice(0, 10);
    for (const city of rows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = city.name;
      btn.addEventListener('click', () => {
        this.location.cityAdcode = city.adcode;
        ($('auth-profile-city') as HTMLInputElement).value = city.name;
        this.closeDropdowns();
      });
      host.append(btn);
    }
  }

  private renderEmptyCityOptions() {
    const host = $('auth-city-options');
    host.innerHTML = `<span class="auth-options-empty">${t('auth.profile.selectProvinceFirst')}</span>`;
  }

  private async submitLogin() {
    const username = ($('auth-login-name') as HTMLInputElement).value;
    const password = ($('auth-login-password') as HTMLInputElement).value;
    try {
      await this.store.login(username, password);
      this.closeOverlay(false);
      toast(t('auth.toast.loggedIn'));
      this.completeSuccess();
    } catch (error) {
      // 登录失败：面板保持打开，仅展示错误，绝不自动关闭（避免待提交成绩丢失）
      this.showMessage(errorMessage(error));
      this.keepOpen();
    }
  }

  private async submitRegister() {
    const username = ($('auth-register-name') as HTMLInputElement).value;
    const password = ($('auth-register-password') as HTMLInputElement).value;
    try {
      const user = await this.store.register(username, password);
      this.closeOverlay(false);
      toast(t('auth.toast.registered', { username: user.username }));
      this.completeSuccess();
    } catch (error) {
      // 注册失败：面板保持打开，仅展示错误，绝不自动关闭
      this.showMessage(errorMessage(error));
      this.keepOpen();
    }
  }

  private async submitProfile() {
    const username = ($('auth-profile-name') as HTMLInputElement).value;
    const provinceText = ($('auth-profile-province') as HTMLInputElement).value.trim();
    const cityText = ($('auth-profile-city') as HTMLInputElement).value.trim();
    const hometown = this.resolveHometown(provinceText, cityText);
    if (hometown instanceof Error) {
      this.showMessage(hometown.message);
      return;
    }
    const update: ProfileUpdate = {
      username,
      hometown,
      avatar: this.avatar,
    };
    try {
      await this.store.updateProfile(update);
      this.closeOverlay();
      toast(t('auth.toast.profileSaved'));
    } catch (error) {
      this.showMessage(errorMessage(error));
    }
  }

  private renderPassword() {
    const user = this.store.currentUser();
    if (!user) {
      this.openLogin();
      return;
    }
    this.card.innerHTML = `
      <h3>${t('auth.password.title')}</h3>
      <label class="form-row">${t('auth.password.oldPassword')}<input id="auth-old-password" type="password" autocomplete="current-password" /></label>
      <label class="form-row">${t('auth.password.newPassword')}<input id="auth-new-password" type="password" autocomplete="new-password" /></label>
      <label class="form-row">${t('auth.password.confirm')}<input id="auth-confirm-password" type="password" autocomplete="new-password" /></label>
      <p id="auth-message" class="auth-message"></p>
      <div class="card-actions">
        <button id="auth-password-save" class="primary" type="button">${t('auth.password.save')}</button>
        <button id="auth-password-cancel" class="ghost" type="button">${t('auth.password.cancel')}</button>
      </div>
    `;
    $('auth-password-save').addEventListener('click', () => this.submitPassword());
    $('auth-password-cancel').addEventListener('click', () => this.closeOverlay());
  }

  private async submitPassword() {
    const oldPassword = ($('auth-old-password') as HTMLInputElement).value;
    const newPassword = ($('auth-new-password') as HTMLInputElement).value;
    const confirm = ($('auth-confirm-password') as HTMLInputElement).value;
    if (!oldPassword) {
      this.showMessage(t('auth.error.oldPasswordRequired'));
      return;
    }
    if (!newPassword) {
      this.showMessage(t('auth.error.passwordRequired'));
      return;
    }
    if (newPassword !== confirm) {
      this.showMessage(t('auth.error.passwordMismatch'));
      return;
    }
    try {
      await this.store.changePassword(oldPassword, newPassword);
      this.closeOverlay(false);
      toast(t('auth.toast.passwordChanged'));
    } catch (error) {
      this.showMessage(errorMessage(error));
    }
  }

  private logout() {
    this.store.logout();
    toast(t('auth.toast.loggedOut'));
  }

  private async readAvatar(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      input.value = '';
      this.showMessage(t('auth.toast.chooseImage'));
      return;
    }
    let compressed: { dataUrl: string; size: number; type: string };
    try {
      compressed = await compressImage(file, MAX_AVATAR_SIZE);
    } catch (error) {
      input.value = '';
      this.showMessage(errorMessage(error));
      return;
    }
    this.avatar = { dataUrl: compressed.dataUrl, name: file.name, size: compressed.size, type: compressed.type };
    const preview = document.querySelector<HTMLElement>('.profile-avatar');
    if (preview) this.paintAvatar(preview, { username: this.store.currentUser()?.username ?? '', avatar: this.avatar });
    this.showMessage(t('auth.toast.avatarSelected'));
  }

  private resolveHometown(provinceText: string, cityText: string): UserHometown | null | Error {
    if (!provinceText && !cityText) return null;
    const province = this.matchProvince(provinceText);
    if (!province) return new Error(t('auth.error.invalidProvince'));
    this.location.provinceAdcode = province.adcode;
    const city = this.matchCity(cityText);
    if (!city || city.provinceAdcode !== province.adcode) return new Error(t('auth.error.invalidCity'));
    this.location.cityAdcode = city.adcode;
    return { provinceAdcode: province.adcode, cityAdcode: city.adcode };
  }

  private rankProvinces(input: string) {
    const ni = normalizeProvince(input);
    const rows = [...this.data.provinces];
    if (!ni) return rows;
    return rows
      .map((province) => ({ province, score: scoreText(ni, normalizeProvince(province.name)) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.province);
  }

  private rankCities(input: string) {
    const rows = this.cityRows();
    const ni = normalize(input);
    if (!ni) return rows;
    return rows
      .map((city) => ({ city, score: Math.max(scoreText(ni, normalize(city.name)), scoreText(ni, city.shortName)) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.city);
  }

  private matchProvince(input: string) {
    const ni = normalizeProvince(input);
    if (!ni) return null;
    return this.data.provinces.find((province) => normalizeProvince(province.name) === ni) ?? null;
  }

  private matchCity(input: string) {
    const ni = normalize(input);
    if (!ni) return null;
    return this.cityRows().find((city) => normalize(city.name) === ni || city.shortName === ni) ?? null;
  }

  private cityRows() {
    return this.data.allUnits.filter((unit) => unit.provinceAdcode === this.location.provinceAdcode && unit.adcode !== '100000_JD');
  }

  private provinceByAdcode(adcode: string) {
    return this.data.provinces.find((province) => province.adcode === adcode) ?? null;
  }

  private cityByAdcode(adcode: string) {
    return this.data.allUnits.find((unit) => unit.adcode === adcode && unit.adcode !== '100000_JD') ?? null;
  }

  private avatarEl(user: Pick<AuthUser, 'username' | 'avatar'> | null, className: string) {
    const el = document.createElement('span');
    el.className = className;
    this.paintAvatar(el, user);
    return el;
  }

  private paintAvatar(el: HTMLElement, user: Pick<AuthUser, 'username' | 'avatar'> | null) {
    el.style.backgroundImage = '';
    el.style.backgroundColor = '';
    el.textContent = '';
    el.classList.toggle('default-avatar', !user);
    if (user?.avatar) {
      el.style.backgroundImage = `url(${user.avatar.dataUrl})`;
      return;
    }
    if (!user) return;
    el.style.backgroundColor = avatarColor(user.username);
    el.textContent = initialOf(user.username);
  }

  /** 登录/注册失败后的防御：确保浮层始终可见，绝不因任何意外路径自动关闭。 */
  private keepOpen() {
    this.overlay.classList.remove('hidden');
  }

  private showMessage(message: string) {
    const el = document.getElementById('auth-message');
    if (el) {
      el.textContent = message;
    } else {
      // 兜底：当前视图没有消息区时用 toast 展示，避免错误静默丢失
      toast(message);
    }
  }
}

function scoreText(input: string, value: string) {
  if (input === value) return 100;
  if (value.startsWith(input)) return 80;
  if (input.length >= 2 && value.includes(input)) return 60;
  return 0;
}

function avatarColor(username: string) {
  let hash = 0;
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initialOf(username: string) {
  const ch = username.trim().charAt(0);
  return ch ? ch.toLocaleUpperCase() : '?';
}

/** 头像压缩：canvas 缩放（最长边 128px）→ 透明补白 → JPEG 质量逐档降到 ≤maxBytes。压到底仍超则抛错。 */
async function compressImage(
  file: File,
  maxBytes: number,
): Promise<{ dataUrl: string; size: number; type: string }> {
  const img = await loadImage(file);
  const maxEdge = 128;
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('auth.error.avatarCompressFail'));
  // 透明背景补白（PNG/GIF 转 JPEG 时避免黑底）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  for (const quality of [0.85, 0.72, 0.6, 0.5, 0.4, 0.3, 0.22, 0.15, 0.1, 0.08]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const size = Math.round(((dataUrl.length - 'data:image/jpeg;base64,'.length) * 3) / 4);
    if (size <= maxBytes) return { dataUrl, size, type: 'image/jpeg' };
  }
  throw new Error(t('auth.toast.avatarTooLarge'));
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('auth.error.avatarReadFail')));
    };
    img.src = url;
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
