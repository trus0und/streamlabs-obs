import { Component, Prop } from 'vue-property-decorator';
import { TObsType, IObsListInput, ObsInput, TObsValue } from './ObsInput';
import { ListInput } from 'components/shared/inputs/inputs';
import InputWrapper from 'components/shared/inputs/InputWrapper';

@Component({
  components: { InputWrapper, ListInput },
})
class ObsListInput extends ObsInput<IObsListInput<TObsValue>> {
  static obsType: TObsType;

  @Prop()
  value: IObsListInput<TObsValue>;

  @Prop({ default: true })
  allowEmpty: boolean;

  @Prop({ default: true })
  internalSearch: boolean;

  @Prop({ default: 'Select Option' })
  placeholder: string;

  @Prop({ default: false })
  loading: boolean;

  onInputHandler(value: string) {
    this.emitInput({ ...this.value, value });
  }

  onSearchChange(value: string) {
    this.$emit('search-change', value);
  }

  get metadata() {
    return {
      loading: this.loading,
      disabled: this.value.enabled === false,
      placeholder: this.placeholder,
      allowEmpty: false,
      internalSearch: this.internalSearch,
      name: this.value.name,
      options: this.value.options.map(opt => ({ title: opt.description, value: opt.value })),
    };
  }
}

ObsListInput.obsType = 'OBS_PROPERTY_LIST';

export default ObsListInput;
