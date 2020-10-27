import cx from 'classnames';
import BaseLayout, { LayoutProps, ILayoutSlotArray } from './BaseLayout';
import { createProps } from 'components/tsx-component';
import { Component } from 'vue-property-decorator';
import ResizeBar from 'components/shared/ResizeBar.vue';
import styles from './Layouts.m.less';

@Component({ props: createProps(LayoutProps) })
export default class OnePaneR extends BaseLayout {
  isColumns = true;

  async mounted() {
    this.mountResize();
    this.$emit('totalWidth', await this.mapVectors([['1', ['3', '4', '5']], '2']), this.isColumns);
    this.setMins(['1', ['3', '4', '5']], ['2']);
  }
  destroyed() {
    this.destroyResize();
  }

  get vectors() {
    return [['1', ['3', '4', '5']], '2'] as ILayoutSlotArray;
  }

  render() {
    return (
      <div class={cx(styles.columns, styles.sidePadded)}>
        <div
          class={styles.rows}
          style={{ width: `${100 - this.resizes.bar1 * 100}%`, paddingTop: '0px' }}
        >
          <div class={styles.cell} style={{ height: '150%' }}>
            {this.$slots['1']}
          </div>
          <div class={styles.segmented}>
            <div class={styles.cell} style="padding-top: 0px;">{this.$slots['3']}</div>
            <div class={styles.cell} style="padding-top: 0px;">{this.$slots['4']}</div>
            <div class={styles.cell} style="padding-top: 0px;">{this.$slots['5']}</div>
          </div>
        </div>
        <ResizeBar
          position="right"
          value={this.bar1}
          onInput={(value: number) => this.setBar('bar1', value)}
          onResizestart={() => this.resizeStartHandler()}
          onResizestop={() => this.resizeStopHandler()}
          max={this.calculateMax(this.mins.rest)}
          min={this.mins.bar1}
          reverse={true}
        />
        <div style={{ width: `${this.resizes.bar1 * 100}%` }} class={styles.cell}>
          {this.$slots['2']}
        </div>
      </div>
    );
  }
}
