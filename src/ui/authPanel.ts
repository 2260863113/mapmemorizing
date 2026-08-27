import { AuthStore, type ProfileUpdate } from '../authStore';
import { normalize, normalizeProvince } from '../matcher';
import type { AppData, AuthUser, UserAvatar, UserHometown } from '../types';
import { $, toast } from './dom';

type AuthView = 'login' | 'register' | 'profile';

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

  constructor(private store: AuthStore, private data: AppData) {
    this.menu = $('user-menu');
    this.overlay = $('auth-panel');
    this.card = $('auth-card');
    this.bindShell();
    this.store.subscribe(() => this.renderTrigger());
    this.renderTrigger();
  }

  private bindShell() {
    $('user-center').addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMenu();
    });
    document.addEventListener('click', () => this.closeMenu());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeMenu();
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
    name.textContent = user?.username ?? '点击登录';
    trigger.append(name);
    this.renderMenu();
  }

  private renderMenu() {
    const user = this.store.currentUser();
    this.menu.innerHTML = '';
    this.menu.append(
      this.menuButton('个人资料', () => this.openProfile(), !user),
      this.menuButton('登录', () => this.openLogin()),
      this.menuButton('登出', () => this.logout(), !user),
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

  private openOverlay(view: AuthView) {
    this.overlay.classList.remove('hidden');
    this.renderView(view);
  }

  private closeOverlay() {
    this.overlay.classList.add('hidden');
  }

  private renderView(view: AuthView) {
    if (view === 'login') this.renderLogin();
    else if (view === 'register') this.renderRegister();
    else this.renderProfile();
  }

  private renderLogin() {
    this.card.innerHTML = `
      <h3>登录</h3>
      <label class="form-row">用户名<input id="auth-login-name" type="text" autocomplete="username" /></label>
      <label class="form-row">密码<input id="auth-login-password" type="password" autocomplete="current-password" /></label>
      <p id="auth-message" class="auth-message"></p>
      <div class="auth-switch"><button id="auth-go-register" type="button">前往注册</button></div>
      <div class="card-actions">
        <button id="auth-login-submit" class="primary" type="button">登录</button>
        <button id="auth-cancel" class="ghost" type="button">取消</button>
      </div>
    `;
    $('auth-go-register').addEventListener('click', () => this.openRegister());
    $('auth-cancel').addEventListener('click', () => this.closeOverlay());
    $('auth-login-submit').addEventListener('click', () => this.submitLogin());
  }

  private renderRegister() {
    this.card.innerHTML = `
      <h3>注册</h3>
      <label class="form-row">昵称<input id="auth-register-name" type="text" maxlength="24" autocomplete="username" /></label>
      <label class="form-row">密码<input id="auth-register-password" type="password" autocomplete="new-password" /></label>
      <p id="auth-message" class="auth-message">密码至少 6 位。</p>
      <div class="card-actions">
        <button id="auth-register-submit" class="primary" type="button">注册</button>
        <button id="auth-register-back" class="ghost" type="button">返回登录</button>
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
      <h3>个人资料</h3>
      <div class="profile-avatar-row">
        <div id="auth-avatar-preview" class="user-avatar profile-avatar"></div>
        <label class="avatar-upload">上传头像<input id="auth-avatar-file" type="file" accept="image/*" /></label>
      </div>
      <label class="form-row">用户名<input id="auth-profile-name" type="text" maxlength="24" value="${escapeAttr(user.username)}" autocomplete="username" /></label>
      <div class="location-grid">
        <label class="form-row">来自省份<input id="auth-profile-province" type="text" value="${escapeAttr(province?.name ?? '')}" placeholder="输入或选择省份" autocomplete="off" /></label>
        <label class="form-row">来自城市<input id="auth-profile-city" type="text" value="${escapeAttr(city?.name ?? '')}" placeholder="输入或选择地级市" autocomplete="off" /></label>
        <div id="auth-province-options" class="auth-options"></div>
        <div id="auth-city-options" class="auth-options"></div>
      </div>
      <div class="settings-section-title">修改密码</div>
      <label class="form-row">旧密码<input id="auth-old-password" type="password" autocomplete="current-password" /></label>
      <label class="form-row">新密码<input id="auth-new-password" type="password" autocomplete="new-password" /></label>
      <p id="auth-message" class="auth-message"></p>
      <div class="card-actions">
        <button id="auth-profile-save" class="primary" type="button">保存</button>
        <button id="auth-profile-cancel" class="ghost" type="button">取消</button>
      </div>
    `;
    this.paintAvatar($('auth-avatar-preview'), { ...user, avatar: this.avatar });
    this.bindProfileInputs();
  }

  private bindProfileInputs() {
    const provinceInput = $('auth-profile-province') as HTMLInputElement;
    const cityInput = $('auth-profile-city') as HTMLInputElement;
    const avatarInput = $('auth-avatar-file') as HTMLInputElement;

    this.renderProvinceOptions(provinceInput.value);
    this.renderCityOptions(cityInput.value);

    provinceInput.addEventListener('input', () => {
      const province = this.matchProvince(provinceInput.value);
      if (province?.adcode !== this.location.provinceAdcode) {
        this.location.provinceAdcode = province?.adcode ?? '';
        this.location.cityAdcode = '';
        cityInput.value = '';
      }
      this.renderProvinceOptions(provinceInput.value);
      this.renderCityOptions(cityInput.value);
    });
    cityInput.addEventListener('input', () => {
      const city = this.matchCity(cityInput.value);
      this.location.cityAdcode = city?.adcode ?? '';
      this.renderCityOptions(cityInput.value);
    });
    avatarInput.addEventListener('change', () => this.readAvatar(avatarInput));
    $('auth-profile-save').addEventListener('click', () => this.submitProfile());
    $('auth-profile-cancel').addEventListener('click', () => this.closeOverlay());
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
        this.renderProvinceOptions(province.name);
        this.renderCityOptions('');
      });
      host.append(btn);
    }
  }

  private renderCityOptions(input: string) {
    const host = $('auth-city-options');
    host.innerHTML = '';
    const rows = this.rankCities(input).slice(0, 10);
    for (const city of rows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = city.name;
      btn.addEventListener('click', () => {
        this.location.cityAdcode = city.adcode;
        ($('auth-profile-city') as HTMLInputElement).value = city.name;
        this.renderCityOptions(city.name);
      });
      host.append(btn);
    }
  }

  private async submitLogin() {
    const username = ($('auth-login-name') as HTMLInputElement).value;
    const password = ($('auth-login-password') as HTMLInputElement).value;
    try {
      await this.store.login(username, password);
      this.closeOverlay();
      toast('已登录');
    } catch (error) {
      this.showMessage(errorMessage(error));
    }
  }

  private async submitRegister() {
    const username = ($('auth-register-name') as HTMLInputElement).value;
    const password = ($('auth-register-password') as HTMLInputElement).value;
    try {
      const user = await this.store.register(username, password);
      this.closeOverlay();
      toast(`已注册并登录：${user.username}`);
    } catch (error) {
      this.showMessage(errorMessage(error));
    }
  }

  private async submitProfile() {
    const username = ($('auth-profile-name') as HTMLInputElement).value;
    const oldPassword = ($('auth-old-password') as HTMLInputElement).value;
    const newPassword = ($('auth-new-password') as HTMLInputElement).value;
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
      oldPassword: oldPassword || undefined,
      newPassword: newPassword || undefined,
    };
    try {
      await this.store.updateProfile(update);
      this.closeOverlay();
      toast('个人资料已保存');
    } catch (error) {
      this.showMessage(errorMessage(error));
    }
  }

  private logout() {
    this.store.logout();
    toast('已登出');
  }

  private async readAvatar(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      input.value = '';
      this.showMessage('头像不能超过 20KB');
      return;
    }
    if (!file.type.startsWith('image/')) {
      input.value = '';
      this.showMessage('请选择图片文件');
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    this.avatar = { dataUrl, name: file.name, size: file.size, type: file.type };
    const preview = document.querySelector<HTMLElement>('.profile-avatar');
    if (preview) this.paintAvatar(preview, { username: this.store.currentUser()?.username ?? '', avatar: this.avatar });
    this.showMessage('头像已选择，保存后生效');
  }

  private resolveHometown(provinceText: string, cityText: string): UserHometown | null | Error {
    if (!provinceText && !cityText) return null;
    const province = this.matchProvince(provinceText);
    if (!province) return new Error('请选择有效省份');
    this.location.provinceAdcode = province.adcode;
    const city = this.matchCity(cityText);
    if (!city || city.provinceAdcode !== province.adcode) return new Error('请选择该省内的有效城市');
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

  private showMessage(message: string) {
    const el = document.getElementById('auth-message');
    if (el) el.textContent = message;
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

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('头像读取失败'));
    reader.readAsDataURL(file);
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
