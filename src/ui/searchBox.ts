/** 搜索框（无联想下拉）：支持回车提交或实时提交 */
export class SearchBox {
  private input: HTMLInputElement;
  private composing = false;
  private requireEnter = true;
  private onSubmitCb: (v: string) => void = () => {};
  private onInputCb: (v: string) => void = () => {};

  constructor(inputId: string) {
    this.input = document.getElementById(inputId) as HTMLInputElement;
    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      if (!this.requireEnter) this.onInputCb(this.input.value);
    });
    this.input.addEventListener('input', () => {
      if (!this.requireEnter && !this.composing) this.onInputCb(this.input.value);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    });
  }

  setRequireEnter(value: boolean) {
    this.requireEnter = value;
  }

  onSubmit(fn: (v: string) => void) {
    this.onSubmitCb = fn;
  }

  onInput(fn: (v: string) => void) {
    this.onInputCb = fn;
  }

  submit() {
    this.onSubmitCb(this.input.value);
  }

  clear() {
    this.input.value = '';
  }

  focus() {
    this.input.focus();
  }

  setPlaceholder(p: string) {
    this.input.placeholder = p;
  }
}
