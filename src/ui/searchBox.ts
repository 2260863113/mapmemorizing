/** 搜索框（无联想下拉）：输入地名回车提交 */
export class SearchBox {
  private input: HTMLInputElement;
  private onSubmitCb: (v: string) => void = () => {};

  constructor(inputId: string) {
    this.input = document.getElementById(inputId) as HTMLInputElement;
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onSubmitCb(this.input.value);
      }
    });
  }

  onSubmit(fn: (v: string) => void) {
    this.onSubmitCb = fn;
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
