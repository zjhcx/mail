<template>
  <div id="login-box" :style="settingStore.settings.background ? { background: 'var(--el-bg-color)' } : {}" v-loading="oauthLoading" element-loading-text="登录中...">
    <div id="background-wrap" v-if="!settingStore.settings.background">
      <div class="x1 cloud"></div>
      <div class="x2 cloud"></div>
      <div class="x3 cloud"></div>
      <div class="x4 cloud"></div>
      <div class="x5 cloud"></div>
    </div>
    <div v-else class="custom-background" :style="background"></div>
    <div class="form-wrapper">
      <div class="container">
        <span class="form-title">{{ settingStore.settings.title }}</span>
        <span class="form-desc" v-if="show === 'login'">{{ $t('loginTitle') }}</span>
        <span class="form-desc" v-else>{{ $t('regTitle') }}</span>
        <div v-show="show === 'login'">
          <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="form.email"
                    type="text" :placeholder="$t('emailAccount')" autocomplete="off" @keyup.enter="submit">
            <template #append v-if="!hideLoginDomain">
              <div @click.stop="openSelect">
                <el-select
                    v-if="show === 'login'"
                    ref="mySelect"
                    v-model="suffix"
                    :placeholder="$t('select')"
                    class="select"
                >
                  <el-option
                      v-for="item in domainList"
                      :key="item"
                      :label="item"
                      :value="item"
                  />
                </el-select>
                <div style="color: var(--el-text-color-primary)">
                  <span>{{ suffix }}</span>
                  <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
                </div>
              </div>
            </template>
          </el-input>
          <el-input v-model="form.password" :placeholder="$t('password')" type="password" autocomplete="off" @keyup.enter="submit">
          </el-input>
          <el-button class="btn" type="primary" @click="submit" :loading="loginLoading"
          >{{ $t('loginBtn') }}
          </el-button>
          <el-button v-for="p in oauthProviders" :key="p.key" class="btn" style="margin-top: 10px" @click="oauthLogin(p.key)">
            <el-avatar v-if="p.iconType === 'image'" :src="p.icon" :size="18" style="margin-right: 10px" />
            <Icon v-else :icon="p.icon" width="18" height="18" style="margin-right: 10px" />
            {{ p.label }}
          </el-button>
        </div>
        <div v-show="show !== 'login'">
          <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="registerForm.email" type="text" :placeholder="$t('emailAccount')"
                    autocomplete="off" @keyup.enter="submitRegister">
            <template #append v-if="!hideLoginDomain">
              <div @click.stop="openSelect">
                <el-select
                    v-if="show !== 'login'"
                    ref="mySelect"
                    v-model="suffix"
                    :placeholder="$t('select')"
                    class="select"
                >
                  <el-option
                      v-for="item in domainList"
                      :key="item"
                      :label="item"
                      :value="item"
                  />
                </el-select>
                <div>
                  <span>{{ suffix }}</span>
                  <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
                </div>
              </div>
            </template>
          </el-input>
          <el-input v-model="registerForm.password" :placeholder="$t('password')" type="password" autocomplete="off" @keyup.enter="submitRegister"/>
          <el-input v-model="registerForm.confirmPassword" :placeholder="$t('confirmPwd')" type="password"
                    autocomplete="off" @keyup.enter="submitRegister"/>
          <el-input v-if="settingStore.settings.regKey === 0" v-model="registerForm.code" :placeholder="$t('regKey')"
                    type="text" autocomplete="off" @keyup.enter="submitRegister"/>
          <el-input v-if="settingStore.settings.regKey === 2" v-model="registerForm.code"
                    :placeholder="$t('regKeyOptional')" type="text" autocomplete="off" @keyup.enter="submitRegister"/>
          <div v-show="verifyShow"
               ref="turnstileContainer"
               :key="turnstileContainerKey"
               class="register-turnstile"
               :data-sitekey="settingStore.settings.siteKey"
               data-callback="onTurnstileSuccess"
               data-error-callback="onTurnstileError"
               data-after-interactive-callback="loadAfter"
               data-before-interactive-callback="loadBefore"
          >
            <span style="font-size: 12px;color: #F56C6C" v-if="botJsError">{{ $t('verifyModuleFailed', {action: $t('regBtn')}) }}</span>
          </div>
          <el-button class="btn" style="margin: 0" type="primary" @click="submitRegister" :loading="registerLoading"
          >{{ $t('regBtn') }}
          </el-button>
          <el-button v-for="p in oauthProviders" :key="p.key" class="btn" style="margin-top: 10px" @click="oauthLogin(p.key)">
            <el-avatar v-if="p.iconType === 'image'" :src="p.icon" :size="18" style="margin-right: 10px" />
            <Icon v-else :icon="p.icon" width="18" height="18" style="margin-right: 10px" />
            {{ p.label }}
          </el-button>
        </div>
        <template v-if="settingStore.settings.register === 0">
          <div class="switch" @click="show = 'register'" v-if="show === 'login'">{{ $t('noAccount') }}
            <span>{{ $t('regSwitch') }}</span></div>
          <div class="switch" @click="show = 'login'" v-else>{{ $t('hasAccount') }} <span>{{ $t('loginSwitch') }}</span>
          </div>
        </template>
      </div>
    </div>
    <el-dialog class="bind-dialog" v-model="showBindForm" @closed="clearBinding" title="注册邮箱" >
      <div class="bind-container">
        <el-input :class="!hideLoginDomain ? 'email-input' : ''" v-model="bindForm.email" type="text" :placeholder="$t('emailAccount')" autocomplete="off" @keyup.enter="bind">
          <template #append v-if="!hideLoginDomain">
            <div @click.stop="openSelect">
              <el-select
                  ref="mySelect"
                  v-model="suffix"
                  :placeholder="$t('select')"
                  class="select"
              >
                <el-option
                    v-for="item in domainList"
                    :key="item"
                    :label="item"
                    :value="item"
                />
              </el-select>
              <div>
                <span>{{ suffix }}</span>
                <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
              </div>
            </div>
          </template>
        </el-input>
        <el-input v-if="settingStore.settings.regKey === 0" v-model="bindForm.code" :placeholder="$t('regKey')"
                  type="text" autocomplete="off" @keyup.enter="bind"/>
        <el-input v-if="settingStore.settings.regKey === 2" v-model="bindForm.code"
                  :placeholder="$t('regKeyOptional')" type="text" autocomplete="off" @keyup.enter="bind"/>
        <div v-show="verifyShow" ref="bindTurnstileContainer"></div>
        <el-button class="btn" type="primary" @click="bind" :loading="bindLoading"
        >绑定
        </el-button>
      </div>
    </el-dialog>
    <a v-show="settingStore.settings.projectLink" class="github" href="https://github.com/maillab/cloud-mail">
      <Icon icon="mingcute:github-line" color="#1890ff" width="20" height="20" />
    </a>
  </div>
</template>

<script setup>
import router from "@/router";
import {computed, nextTick, onBeforeUnmount, reactive, ref, watch} from "vue";
import {login} from "@/request/login.js";
import {register} from "@/request/login.js";
import {websiteConfig} from "@/request/setting.js";
import {isEmail} from "@/utils/verify-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useUserStore} from "@/store/user.js";
import {useUiStore} from "@/store/ui.js";
import {Icon} from "@iconify/vue";
import {getBackgroundStyle} from "@/utils/background.js";
import {loginUserInfo} from "@/request/my.js";
import {permsToRouter} from "@/perm/perm.js";
import {useI18n} from "vue-i18n";
import {oauthStart, oauthBindUser, oauthLinuxDoLogin, oauthGithubLogin, oauthGoogleLogin} from "@/request/ouath.js";
import {rememberOAuth, consumeOAuthCallback, registrationNeedsVerification, OAUTH_STORAGE_KEY} from "@/utils/oauth-flow.js";
import {reloadTurnstileScript} from "@/utils/turnstile-script.js";

const {t} = useI18n();
const accountStore = useAccountStore();
const userStore = useUserStore();
const uiStore = useUiStore();
const settingStore = useSettingStore();
const loginLoading = ref(false)
const bindLoading = ref(false)
const oauthLoading = ref(false);
const showBindForm = ref(false);
const show = ref('login')

const oauthKeys = ['linuxdo', 'github', 'google']


const oauthProviders = computed(() => {
  const allProviders = [
    { key: 'google', label: 'Google', icon: 'devicon:google', iconType: 'iconify' },
    { key: 'github', label: 'GitHub', icon: 'codicon:github-inverted', iconType: 'iconify' },
    { key: 'linuxdo', label: 'LinuxDo', icon: '/image/linuxdo.webp', iconType: 'image' },
  ]
  return allProviders.filter(p => settingStore.settings[p.key + 'Switch'] === 0)
})

const bindForm = reactive({
  email: '',
  bindToken: '',
  code: ''
})

const form = reactive({
  email: '',
  password: '',

});
const mySelect = ref()
const suffix = ref('')
const registerForm = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  code: null
})
const domainList = settingStore.domainList;
const registerLoading = ref(false)
suffix.value = domainList[0]
const verifyShow = ref(false)
let verifyToken = ''
let turnstileId = null
let verificationVersion = 0
let botJsError = ref(false)
let turnstileRecoveryAttempted = false
const turnstileContainer = ref(null)
const bindTurnstileContainer = ref(null)
const turnstileContainerKey = ref(0)
const needsVerification = computed(() => registrationNeedsVerification(settingStore.settings))

function removeVerification() {
  ++verificationVersion
  if (turnstileId !== null) {
    try { window.turnstile?.remove(turnstileId) } catch {}
  }
  turnstileId = null
  verifyToken = ''
}

async function ensureVerification(forceReload = false) {
  if (turnstileRecoveryAttempted) return
  turnstileRecoveryAttempted = true
  const requestedVersion = verificationVersion
  botJsError.value = false
  verifyShow.value = true
  try {
    const api = forceReload || !window.turnstile ? await reloadTurnstileScript() : window.turnstile
    await nextTick()
    if (requestedVersion !== verificationVersion) return
    const target = showBindForm.value ? bindTurnstileContainer.value : turnstileContainer.value
    if (!target || (!showBindForm.value && show.value === 'login')) return
    removeVerification()
    const widgetVersion = verificationVersion
    turnstileId = api.render(target, {
      sitekey: settingStore.settings.siteKey,
      callback: token => { if (widgetVersion === verificationVersion) verifyToken = token },
      'expired-callback': () => { if (widgetVersion === verificationVersion) verifyToken = '' },
      'error-callback': () => { if (widgetVersion === verificationVersion) { verifyToken = ''; botJsError.value = true } },
    })
  } catch {
    botJsError.value = true
    ElMessage.error('人机验证加载失败，请重试')
  } finally {
    turnstileRecoveryAttempted = false
  }
}

function requireVerification() {
  if (!needsVerification.value || verifyToken) return true
  if (!verifyShow.value || botJsError.value || turnstileId === null) ensureVerification(botJsError.value)
  else ElMessage.error(t('botVerifyMsg'))
  return false
}

function clearBinding() {
  bindForm.bindToken = ''
  bindForm.code = ''
  removeVerification()
  verifyShow.value = false
}

watch(show, () => {
  removeVerification()
  verifyShow.value = false
})
onBeforeUnmount(removeVerification)

const loginOpacity = computed(() => {
  const opacity = settingStore.settings.loginOpacity
  return uiStore.dark ? `rgba(0, 0, 0, ${opacity})` : `rgba(255, 255, 255, ${opacity})`
})

const hideLoginDomain = computed(() => settingStore.settings.loginDomain === 1)

const background = computed(() => getBackgroundStyle(
  settingStore.settings.background,
  settingStore.settings.r2Domain,
))

const openSelect = () => {
  mySelect.value.toggleMenu()
}

const getFullEmail = (email) => {
  return hideLoginDomain.value ? email : email + suffix.value
}

const getEmailName = (email) => {
  return email.split('@')[0]
}

async function oauthLogin(provider) {
  if (!oauthKeys.includes(provider) || oauthLoading.value) return
  clearBinding()
  sessionStorage.removeItem(OAUTH_STORAGE_KEY)
  oauthLoading.value = true
  try {
    const redirectUri = window.location.origin + '/login'
    const data = await oauthStart(provider, redirectUri)
    const target = rememberOAuth(sessionStorage, provider, redirectUri, data, window.location.origin)
    window.location.assign(target)
  } catch (error) {
    sessionStorage.removeItem(OAUTH_STORAGE_KEY)
    ElMessage.error(error.message || 'OAuth 登录启动失败，请重试')
    oauthLoading.value = false
  }
}

const loginFns = {
  linuxdo: oauthLinuxDoLogin,
  github: oauthGithubLogin,
  google: oauthGoogleLogin,
}

oauthGetUser();

async function oauthGetUser() {
  let callback
  try {
    callback = consumeOAuthCallback(sessionStorage, window.location.search, window.location.origin)
  } catch (error) {
    window.history.replaceState({}, '', window.location.origin + window.location.pathname)
    clearBinding()
    ElMessage.error(error.message)
    return
  }
  if (!callback) return
  window.history.replaceState({}, '', window.location.origin + window.location.pathname)
  oauthLoading.value = true
  try {
    const data = await loginFns[callback.provider](callback.code, callback.redirectUri, callback.state)
    if (typeof data.token === 'string' && data.token) {
      await saveToken(data.token)
      return
    }
    if (typeof data.bindToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.bindToken)) throw new Error('OAuth 绑定凭据无效，请重新登录')
    if (settingStore.settings.register !== 0) throw new Error('注册已关闭，无法创建新的 OAuth 邮箱；已有绑定账户仍可登录')
    bindForm.bindToken = data.bindToken
    showBindForm.value = true
    ElMessage.warning('请注册绑定一个邮箱；绑定凭据仅限本次使用，有效期10分钟')
    if (needsVerification.value) await ensureVerification()
  } catch (error) {
    showBindForm.value = false
    clearBinding()
    ElMessage.error(error.message || 'OAuth 登录失败，请重新登录')
  } finally {
    oauthLoading.value = false
  }
}

function bind() {

  if (bindLoading.value) return
  if (!bindForm.bindToken || settingStore.settings.register !== 0) {
    clearBinding()
    showBindForm.value = false
    ElMessage.error('绑定凭据失效或注册已关闭，请重新进行 OAuth 登录')
    return
  }

  if (!bindForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }


  if (getEmailName(bindForm.email).length < settingStore.settings.minEmailPrefix) {
    ElMessage({
      message: t('minEmailPrefix', {msg: settingStore.settings.minEmailPrefix}),
      type: 'error',
      plain: true,
    })
    return
  }

  let email = getFullEmail(bindForm.email);


  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (settingStore.settings.regKey === 0) {

    if (!bindForm.code) {

      ElMessage({
        message: t('emptyRegKeyMsg'),
        type: 'error',
        plain: true,
      })
      return
    }

  }

  if (!requireVerification()) return
  const form = {email, bindToken: bindForm.bindToken, code: bindForm.code, token: verifyToken}

  bindLoading.value = true
  oauthBindUser(form).then(async data => {
    if (typeof data.token !== 'string' || !data.token) throw new Error('绑定结果无效')
    clearBinding()
    await saveToken(data.token)
  }).catch(() => {
    clearBinding()
    showBindForm.value = false
    ElMessage.error('绑定失败，本次凭据已作废，请重新点击 OAuth 登录后重试')
  }).finally(() => { bindLoading.value = false })
}

const submit = () => {

  if (loginLoading.value) return

  if (!form.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  let email = getFullEmail(form.email);

  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  loginLoading.value = true
  login(email, form.password).then(async data => {
    await saveToken(data.token)
  }).finally(() => {
    loginLoading.value = false
  })
}

async function saveToken(token) {
  localStorage.setItem('token', token)
  refreshWebsiteConfig()
  const user = await loginUserInfo();
  accountStore.currentAccountId = user.account.accountId;
  accountStore.currentAccount = user.account;
  userStore.user = user;
  const routers = permsToRouter(user.permKeys);
  routers.forEach(routerData => {
    router.addRoute('layout', routerData);
  });
  await router.replace({name: 'layout'})
  uiStore.showNotice()
  oauthLoading.value = false;
  bindLoading.value = false;
}

function refreshWebsiteConfig() {
  websiteConfig().then(setting => {
    settingStore.settings = setting
    settingStore.domainList = setting.domainList
    if (!suffix.value && setting.domainList.length > 0) {
      suffix.value = setting.domainList[0]
    }
    document.title = setting.title
  }).catch(e => {
    console.error(e)
  })
}


function submitRegister() {

  if (registerLoading.value) return

  if (!registerForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  console.log(registerForm.email)

  if (getEmailName(registerForm.email).length < settingStore.settings.minEmailPrefix) {
    ElMessage({
      message: t('minEmailPrefix', {msg: settingStore.settings.minEmailPrefix}),
      type: 'error',
      plain: true,
    })
    return
  }

  const email = getFullEmail(registerForm.email);

  if (!isEmail(email)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!registerForm.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (registerForm.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (registerForm.password !== registerForm.confirmPassword) {

    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (settingStore.settings.regKey === 0) {

    if (!registerForm.code) {

      ElMessage({
        message: t('emptyRegKeyMsg'),
        type: 'error',
        plain: true,
      })
      return
    }

  }

  if (!requireVerification()) return

  registerLoading.value = true

  const form = {
    email,
    password: registerForm.password,
    token: verifyToken,
    code: registerForm.code
  }

  register(form).then(({regVerifyOpen}) => {
    show.value = 'login'
    registerForm.email = ''
    registerForm.password = ''
    registerForm.confirmPassword = ''
    registerForm.code = ''
    registerLoading.value = false
    removeVerification()
    settingStore.settings.regVerifyOpen = regVerifyOpen
    verifyShow.value = false
    ElMessage({
      message: t('regSuccessMsg'),
      type: 'success',
      plain: true,
    })
  }).catch(res => {

    registerLoading.value = false

    verifyToken = ''
    if (res.code === 400) {
      settingStore.settings.regVerifyOpen = true
    }
    if (needsVerification.value) ensureVerification()

  });
}

</script>


<style>
.el-select-dropdown__item {
  padding: 0 15px;
}

.no-autofill-pwd {
  .el-input__inner {
    -webkit-text-security: disc !important;
  }
}
</style>

<style lang="scss" scoped>

.form-wrapper {
  position: relative;
  height: 100%;
  min-height: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 48px clamp(24px, 7vw, 120px);
  z-index: 10;
  display: flex;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.container {
  box-sizing: border-box;
  background: v-bind(loginOpacity);
  background: color-mix(in srgb, v-bind(loginOpacity) 88%, transparent);
  backdrop-filter: blur(24px) saturate(145%);
  -webkit-backdrop-filter: blur(24px) saturate(145%);
  padding: 40px;
  display: flex;
  flex-direction: column;
  width: 440px;
  max-width: 100%;
  flex-shrink: 0;
  margin: auto 0 auto auto;
  border: 1px solid var(--login-border);
  border-radius: 28px;
  box-shadow: 0 24px 72px rgba(15, 23, 42, 0.16),
    0 4px 16px rgba(15, 23, 42, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.22);
  color: var(--el-text-color-primary);

  @media (max-width: 767px) {
    margin: auto;
    padding: 30px 24px;
    border-radius: 24px;
  }

  .btn {
    min-height: 44px;
    height: auto;
    padding: 12px 16px;
    width: 100%;
    border-radius: 12px;
    font-weight: 600;
    transition: box-shadow 0.2s ease, background-color 0.2s ease;

    &.el-button--primary {
      box-shadow: 0 6px 18px rgba(64, 158, 255, 0.2);
    }
  }

  .form-desc {
    margin-top: 10px;
    margin-bottom: 28px;
    color: var(--form-desc-color);
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  .form-title {
    font-weight: 700;
    font-size: 28px;
    line-height: 1.3;
    letter-spacing: -0.5px;
    overflow-wrap: anywhere;
  }

  .switch {
    margin-top: 26px;
    text-align: center;
    font-size: 13px;
    line-height: 1.7;
    color: var(--el-text-color-regular);

    span {
      color: var(--login-switch-color);
      cursor: pointer;
    }
  }

  :deep(.el-input__wrapper) {
    border-radius: 12px;
    background: var(--el-bg-color);
    background: color-mix(in srgb, var(--el-bg-color) 82%, transparent);
    padding: 1px 14px;
  }

  .email-input :deep(.el-input__wrapper) {
    border-radius: 12px 0 0 12px;
    min-width: 0;
  }

  .el-input {
    height: 46px;
    width: 100%;
    margin-bottom: 18px;

    :deep(.el-input__inner) {
      height: 44px;
    }
  }

  :deep(.el-input-group__append) {
    max-width: 52%;
    border-radius: 0 12px 12px 0;

    > div > div:last-child {
      display: flex;
      align-items: center;
      min-width: 0;

      span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .setting-icon {
      top: 0;
      flex-shrink: 0;
    }
  }
}

:deep(.el-select-dropdown__item) {
  padding: 0 10px;
}

:deep(.bind-dialog) {
  width: 400px !important;
  @media (max-width: 440px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
}

.bind-container {
  display: grid;
  grid-template-columns: 1fr;
  gap: 15px;
}

.setting-icon {
  position: relative;
  top: 6px;
}

.github {
  position: fixed;
  width: 35px;
  height: 35px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  background: var(--el-bg-color);
  bottom: 10px;
  right: 10px;
  z-index: 1000;
  border: 1px solid var(--el-border-color-light);
  box-shadow: var(--el-box-shadow-light);
  cursor: pointer;
}

:deep(.el-input-group__append) {
  padding: 0 !important;
  padding-left: 8px !important;
  padding-right: 4px !important;
  background: var(--el-bg-color);
  border-radius: 0 8px 8px 0;
}

:deep(.el-button+.el-button) {
  margin: 0;
}

.register-turnstile {
  margin-bottom: 18px;
  max-width: 100%;
  overflow-x: auto;
}

.select {
  position: absolute;
  right: 30px;
  width: 100px;
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}

.custom-style {
  margin-bottom: 10px;
}

.custom-style .el-segmented {
  --el-border-radius-base: 6px;
  width: 180px;
}


#login-box {
  position: relative;
  isolation: isolate;
  background: linear-gradient(145deg, #599bc8 0%, #b4dcef 52%, #eef5fb 100%);
  font-family: inherit;
  height: 100%;
  min-height: 100dvh;
  margin: 0;
  padding: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(0, 1fr);

  @media (max-width: 767px) {
    .form-wrapper {
      padding: 24px 16px 60px;
      padding-bottom: max(60px, env(safe-area-inset-bottom));
    }
  }

  @media (max-width: 359px) {
    .container {
      padding: 28px 18px;
    }
  }
}

#background-wrap,
.custom-background {
  position: absolute;
  inset: 0;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .cloud {
    animation: none;
  }

  .container .btn {
    transition: none;
  }
}

@keyframes animateCloud {
  0% {
    margin-left: -500px;
  }

  100% {
    margin-left: 100%;
  }
}

.x1 {
  animation: animateCloud 30s linear infinite;
  transform: scale(0.65);
}

.x2 {
  animation: animateCloud 15s linear infinite;
  transform: scale(0.3);
}

.x3 {
  animation: animateCloud 25s linear infinite;
  transform: scale(0.5);
}

.x4 {
  animation: animateCloud 13s linear infinite;
  transform: scale(0.4);
}

.x5 {
  animation: animateCloud 20s linear infinite;
  transform: scale(0.55);
}

.cloud {
  background: linear-gradient(to bottom, #fff 5%, #f1f1f1 100%);
  border-radius: 100px;
  box-shadow: 0 8px 5px rgba(0, 0, 0, 0.1);
  height: 120px;
  width: 350px;
  position: relative;
}

.cloud:after,
.cloud:before {
  content: "";
  position: absolute;
  background: #fff;
  z-index: -1;
}

.cloud:after {
  border-radius: 100px;
  height: 100px;
  left: 50px;
  top: -50px;
  width: 100px;
}

.cloud:before {
  border-radius: 200px;
  height: 180px;
  width: 180px;
  right: 50px;
  top: -90px;
}

</style>
