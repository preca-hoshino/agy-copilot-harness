const { validateSnippetSyntax } = require('./validate');

const MODE_SECTION_ID = 'agentHostModePicker.mode';
const PERMISSIONS_SECTION_ID = 'agentHostModePicker.permissions';

function isAntigravityModeGroup(group, sessionResource) {
  if (!group || group.id !== 'mode') {
    return false;
  }
  if (sessionResource?.scheme === 'antigravity') {
    return true;
  }
  return Array.isArray(group.items) && group.items.some((item) => item?.agyPickerMeta?.provider === 'antigravity');
}

function defaultMetaForOption(item) {
  switch (item?.id) {
    case 'default':
      return {
        category: 'permission',
        pickerLabel: 'Manual permissions',
        shortLabel: 'Manual',
        detail: 'Ask before edits and commands',
        tone: '',
        iconId: 'shield',
      };
    case 'accept-edits':
      return {
        category: 'permission',
        pickerLabel: 'Accept edits',
        shortLabel: 'Accept edits',
        detail: 'Auto-approve workspace file edits',
        tone: 'info',
        iconId: 'edit',
      };
    case 'auto':
      return {
        category: 'permission',
        pickerLabel: 'Auto',
        shortLabel: 'Auto',
        detail: 'Automatically approve one-time tool requests',
        tone: 'warning',
        iconId: 'zap',
      };
    case 'plan':
      return {
        category: 'mode',
        pickerLabel: 'Plan',
        shortLabel: 'Plan',
        detail: 'Plan changes before executing',
        tone: '',
        iconId: 'checklist',
      };
    default:
      return {
        category: 'permission',
        pickerLabel: item?.name || String(item?.id || ''),
        shortLabel: item?.name || String(item?.id || ''),
        detail: item?.description || '',
        tone: '',
        iconId: item?.icon?.id || 'settings-sliders',
      };
  }
}

function resolveModePermissionsViewModel(group, currentOption, rememberedInteractiveId) {
  const items = Array.isArray(group?.items) ? group.items : [];
  const current = currentOption || group?.selected || items[0];
  const isPlan = current?.id === 'plan';
  const anyMeta =
    current?.agyPickerMeta ||
    group?.selected?.agyPickerMeta ||
    items.find((item) => item?.agyPickerMeta)?.agyPickerMeta;

  const permissionItems = items.filter((item) => item && item.id !== 'plan');
  const planItem = items.find((item) => item && item.id === 'plan');
  const effectiveInteractiveId =
    !isPlan && current?.id
      ? current.id
      : rememberedInteractiveId && rememberedInteractiveId !== 'plan'
        ? rememberedInteractiveId
        : anyMeta?.lastInteractiveMode && anyMeta.lastInteractiveMode !== 'plan'
          ? anyMeta.lastInteractiveMode
          : 'default';

  const activePermItem =
    permissionItems.find((item) => item.id === effectiveInteractiveId) || permissionItems[0] || undefined;

  const modeDefaults = defaultMetaForOption(planItem || current);
  const modeLabel = isPlan ? planItem?.agyPickerMeta?.shortLabel || planItem?.name || 'Plan' : 'Interactive';
  const modeIconId = isPlan ? planItem?.icon?.id || modeDefaults.iconId : 'comment';

  const permDefaults = defaultMetaForOption(activePermItem);
  const permMeta = activePermItem?.agyPickerMeta;
  const permShortLabel = activePermItem ? permMeta?.shortLabel || permDefaults.shortLabel : 'Plan';
  const permTone = isPlan ? '' : permMeta ? permMeta.tone || '' : permDefaults.tone;

  return {
    items,
    current,
    isPlan,
    planItem,
    permissionItems,
    effectiveInteractiveId,
    activePermItem,
    modeLabel,
    modeIconId,
    permShortLabel,
    permTone,
  };
}

function buildModePermissionsActionItems(vm, callbacks) {
  const {
    onSelectInteractive,
    onSelectPlan,
    onSelectPermission,
    onConfigurePermissions,
  } = callbacks || {};

  const hasInteractive = vm.permissionItems.length > 0;
  const interactiveDisabled = Boolean(vm.current?.locked || !hasInteractive);
  const planDisabled = Boolean(vm.planItem?.locked);

  const actionItems = [
    {
      kind: 'action',
      label: 'Agent mode',
      item: {
        id: MODE_SECTION_ID,
        label: 'Agent mode',
        tooltip: 'Agent mode',
        enabled: true,
        run: () => {},
      },
      disabled: false,
      section: MODE_SECTION_ID,
      isSectionToggle: true,
      description: vm.modeLabel,
      ariaDescription: `Current mode: ${vm.modeLabel}`,
      className: 'agent-host-mode-section',
    },
    {
      kind: 'action',
      label: 'Interactive',
      detail: 'Works with you and asks for input when needed.',
      group: { title: '', icon: { id: 'comment' } },
      disabled: interactiveDisabled,
      focusableWhenDisabled: true,
      section: MODE_SECTION_ID,
      item: {
        id: 'antigravity.agentMode.interactive',
        label: 'Interactive',
        tooltip: 'Works with you and asks for input when needed.',
        enabled: !interactiveDisabled,
        checked: !vm.isPlan,
        class: undefined,
        run: () => {
          if (!interactiveDisabled && vm.isPlan && vm.activePermItem) {
            onSelectInteractive?.(vm.activePermItem);
          }
        },
      },
    },
  ];

  if (vm.planItem) {
    const planDefaults = defaultMetaForOption(vm.planItem);
    const planDetail = vm.planItem.description || vm.planItem.agyPickerMeta?.detail || planDefaults.detail;
    actionItems.push({
      kind: 'action',
      label: vm.planItem.agyPickerMeta?.pickerLabel || vm.planItem.name || 'Plan',
      detail: planDetail,
      group: { title: '', icon: { id: vm.planItem.icon?.id || 'checklist' } },
      disabled: planDisabled,
      focusableWhenDisabled: true,
      section: MODE_SECTION_ID,
      item: {
        id: 'antigravity.agentMode.plan',
        label: vm.planItem.agyPickerMeta?.pickerLabel || vm.planItem.name || 'Plan',
        tooltip: planDetail,
        enabled: !planDisabled,
        checked: vm.isPlan,
        class: undefined,
        run: () => {
          if (!planDisabled && !vm.isPlan) {
            onSelectPlan?.(vm.planItem, vm.current?.id);
          }
        },
      },
    });
  }

  actionItems.push({
    kind: 'separator',
    section: MODE_SECTION_ID,
  });

  const permissionsHeaderDesc = vm.permShortLabel;
  actionItems.push({
    kind: 'action',
    label: 'Permissions',
    item: {
      id: PERMISSIONS_SECTION_ID,
      label: 'Permissions',
      tooltip: 'Permissions',
      enabled: true,
      run: () => {},
    },
    disabled: false,
    section: PERMISSIONS_SECTION_ID,
    isSectionToggle: true,
    description: permissionsHeaderDesc,
    ariaDescription: `Current permissions: ${vm.permShortLabel}`,
    className: ['agent-host-mode-permissions', vm.permTone].filter(Boolean).join(' '),
    toolbarActions: [
      {
        id: 'agentHostModePicker.configurePermissions',
        label: 'Configure Permissions',
        tooltip: 'Configure Permissions',
        class: 'codicon codicon-gear',
        enabled: true,
        checked: undefined,
        run: () => {
          onConfigurePermissions?.();
        },
      },
    ],
  });

  for (const permItem of vm.permissionItems) {
    const defaults = defaultMetaForOption(permItem);
    const meta = permItem.agyPickerMeta;
    const permLabel = meta?.pickerLabel || defaults.pickerLabel;
    const permDetail = permItem.description || meta?.detail || defaults.detail;
    const isDisabled = vm.isPlan || Boolean(permItem.locked);
    const isChecked = !vm.isPlan && permItem.id === vm.current?.id;
    const iconId = permItem.icon?.id || defaults.iconId;

    actionItems.push({
      kind: 'action',
      label: permLabel,
      detail: permDetail,
      group: { title: '', icon: { id: iconId } },
      disabled: isDisabled,
      focusableWhenDisabled: true,
      section: PERMISSIONS_SECTION_ID,
      item: {
        id: `antigravity.permission.${permItem.id}`,
        label: permLabel,
        tooltip: permDetail || permLabel,
        enabled: !isDisabled,
        checked: isChecked,
        class: undefined,
        run: () => {
          if (!isDisabled) {
            onSelectPermission?.(permItem);
          }
        },
      },
    });
  }

  return actionItems;
}

function buildModePermissionsPickerSnippet({ el, children, group, compact, label, isDefaultIcon, renderIcon, toIcon, dom, reset }) {
  const helpers = [
    `const _agyIsModeGroup=${isAntigravityModeGroup.toString()};`,
    `const _agyDefaultMetaForOption=${defaultMetaForOption.toString()};`,
    `const _agyResolveViewModel=${resolveModePermissionsViewModel.toString()};`,
    `const _agyBuildActionItems=${buildModePermissionsActionItems.toString()};`,
  ]
    .join('')
    .replaceAll('defaultMetaForOption', '_agyDefaultMetaForOption')
    .replaceAll('MODE_SECTION_ID', JSON.stringify(MODE_SECTION_ID))
    .replaceAll('PERMISSIONS_SECTION_ID', JSON.stringify(PERMISSIONS_SECTION_ID));

  const runtime = [
    helpers,
    `if(!_agyIsModeGroup(${group},this.delegate?.getSessionResource?.())){`,
    `  if(${el}.classList.contains("agent-host-mode-permissions-trigger")){`,
    `    ${el}.classList.remove("chat-input-picker-split","agent-host-mode-permissions-trigger");`,
    `    ${el}.style.padding="";${el}.style.overflow="";${el}.style.background="";`,
    `    ${el}.removeAttribute("data-mode-permissions-picker-open");`,
    `    ${el}.removeAttribute("tabindex");`,
    `    this.container?.classList.remove("agent-host-chat-input-picker-slot","compact-picker");`,
    `    this._agySplitState=void 0;`,
    `  }`,
    `}else{`,
    `  const _agyResolve=()=>{const _g=this.delegate.getOptionGroup();return _agyResolveViewModel(_g,this.currentOption,_g?.items?.length?this._agyLastInteractiveId:void 0);};`,
    `  const _agyVm=_agyResolve();`,
    `  if(!_agyVm.isPlan&&_agyVm.current?.id){this._agyLastInteractiveId=_agyVm.current.id;}`,
    `  this.container?.classList.add("agent-host-chat-input-picker-slot");`,
    `  this.container?.classList.toggle("compact-picker",Boolean(${compact}));`,
    `  ${el}.classList.add("chat-input-picker-split","agent-host-mode-permissions-trigger");`,
    `  ${el}.classList.remove("icon-only");`,
    `  ${el}.style.padding="0";${el}.style.overflow="visible";${el}.style.background="transparent";`,
    `  ${el}.role="group";${el}.tabIndex=-1;`,
    `  ${el}.removeAttribute("aria-haspopup");${el}.removeAttribute("aria-expanded");`,
    `  if(!this._agySplitState||this._agySplitState.el!==${el}){`,
    `    const _mBtn=${dom}("a.action-label.chat-input-picker-split-button.chat-input-picker-split-primary.agent-host-mode-picker-button.agent-host-mode-button");`,
    `    const _pBtn=${dom}("a.action-label.chat-input-picker-split-button.chat-input-picker-split-secondary.agent-host-mode-picker-button.agent-host-permissions-button");`,
    `    const _isLocked=()=>Boolean(this.currentOption?.locked||this._action?.enabled===!1||${el}.classList.contains("disabled"));`,
    `    const _show=(openPerms,focusBtn)=>{`,
    `      if(_isLocked()||!this._actionWidgetService){return;}`,
    `      if(this._actionWidgetService.isVisible){`,
    `        const _same=this._agyOpenBtn===focusBtn;`,
    `        this._actionWidgetService.hide();`,
    `        if(_same){return;}`,
    `      }`,
    `      const _v=_agyResolve();`,
    `      const _items=_agyBuildActionItems(_v,{`,
    `        onSelectInteractive:(_item)=>{this.currentOption=_item;this.delegate.setOption(_item);},`,
    `        onSelectPlan:(_item,_curId)=>{if(_curId&&_curId!=="plan"){this._agyLastInteractiveId=_curId;}this.currentOption=_item;this.delegate.setOption(_item);},`,
    `        onSelectPermission:(_item)=>{this._agyLastInteractiveId=_item.id;this.currentOption=_item;this.delegate.setOption(_item);},`,
    `        onConfigurePermissions:()=>{this._actionWidgetService.hide();this.commandService?.executeCommand?.("antigravityHarness.openSettings");},`,
    `      });`,
    `      const _baseOpts=this.actionWidgetOptions?.listOptions||{};`,
    `      const _wClasses=(_baseOpts.widgetClassName||"").split(/\\s+/).filter(Boolean);`,
    `      if(!_wClasses.includes("agent-host-mode-permissions-popup")){_wClasses.push("agent-host-mode-permissions-popup");}`,
    `      const _focusId=openPerms?("antigravity.permission."+(_v.activePermItem?.id||"default")):(_v.isPlan?"antigravity.agentMode.plan":"antigravity.agentMode.interactive");`,
    `      const _isChecked=(_it)=>_it.kind==="action"&&!_it.isSectionToggle&&!_it.standaloneToggle?_it.item?.checked:void 0;`,
    `      const _a11y={getWidgetAriaLabel:()=>"Pick Mode and Permissions",isChecked:_isChecked,getRole:(_it)=>_it.kind==="action"?(_isChecked(_it)!==void 0?"menuitemradio":"menuitem"):"separator",getWidgetRole:()=>"menu"};`,
    `      const _anchor=this._getAnchorElement?.()??${el};`,
    `      const _ret=focusBtn||_mBtn;`,
    `      this._agyOpenBtn=_ret;`,
    `      ${el}.setAttribute("data-mode-permissions-picker-open","true");`,
    `      _mBtn.ariaExpanded=openPerms?"false":"true";`,
    `      _pBtn.ariaExpanded=openPerms?"true":"false";`,
    `      this._actionWidgetService.show("agentHostChatInputPicker.mode",!1,_items,{`,
    `        onSelect:(_act)=>{this._actionWidgetService.hide();_act?.run?.();},`,
    `        onHide:()=>{this._agyOpenBtn=void 0;${el}.removeAttribute("data-mode-permissions-picker-open");_mBtn.ariaExpanded="false";_pBtn.ariaExpanded="false";_ret?.focus?.();},`,
    `      },_anchor,void 0,[],_a11y,{`,
    `        ..._baseOpts,`,
    `        minWidth:300,anchorPosition:1,useFullHeight:!0,`,
    `        widgetClassName:_wClasses.join(" "),`,
    `        collapsedByDefault:new Set([openPerms?${JSON.stringify(MODE_SECTION_ID)}:${JSON.stringify(PERMISSIONS_SECTION_ID)}]),`,
    `        initialFocusItemId:_focusId,`,
    `        reserveSubmenuSpace:!1,`,
    `      });`,
    `    };`,
    `    const _bind=(btn,openPerms)=>{`,
    `      btn.role="button";btn.ariaHasPopup="menu";btn.ariaExpanded="false";`,
    `      btn.addEventListener("mousedown",(_ev)=>{if(_ev.button===0){_ev.preventDefault();_ev.stopPropagation();_show(openPerms,btn);}});`,
    `      btn.addEventListener("click",(_ev)=>{_ev.preventDefault();_ev.stopPropagation();});`,
    `      btn.addEventListener("keydown",(_ev)=>{if(_ev.key==="Enter"||_ev.key===" "||_ev.key==="ArrowDown"){_ev.preventDefault();_ev.stopPropagation();_show(openPerms,btn);}});`,
    `    };`,
    `    _bind(_mBtn,!1);_bind(_pBtn,!0);`,
    `    this._agySplitState={el:${el},modeBtn:_mBtn,permBtn:_pBtn,show:_show};`,
    `  }`,
    `  const _hookDd=()=>{`,
    `    const _dd=this.actionWidgetDropdown;`,
    `    if(_dd&&!_dd._agyWrappedShow){`,
    `      _dd._agyWrappedShow=!0;const _orig=_dd.show.bind(_dd);`,
    `      _dd.show=()=>{if(${el}.classList.contains("agent-host-mode-permissions-trigger")){this._agySplitState?.show(!1,this._agySplitState.modeBtn);return;}return _orig();};`,
    `    }`,
    `  };`,
    `  _hookDd();if(!this.actionWidgetDropdown&&typeof queueMicrotask==="function"){queueMicrotask(_hookDd);}`,
    `  const{_agySplitState:{modeBtn:_mBtn,permBtn:_pBtn}}=this;`,
    `  const _disabled=Boolean(this.currentOption?.locked||this._action?.enabled===!1||${el}.classList.contains("disabled"));`,
    `  _mBtn.tabIndex=_disabled?-1:0;_pBtn.tabIndex=_disabled?-1:0;`,
    `  _mBtn.ariaDisabled=_disabled?"true":"false";_pBtn.ariaDisabled=_disabled?"true":"false";`,
    `  const _iconEl=${renderIcon}(${toIcon}({id:_agyVm.modeIconId}));`,
    `  if(_iconEl){_iconEl.ariaHidden="true";}`,
    `  ${reset}(_mBtn,...(_iconEl?[_iconEl]:[]),${dom}("span.agent-host-chat-input-picker-label.chat-session-option-label",void 0,_agyVm.modeLabel));`,
    `  const _permClass="span.agent-host-mode-permission-summary"+(_agyVm.permTone?"."+_agyVm.permTone:"");`,
    `  ${reset}(_pBtn,${dom}(_permClass,void 0,_agyVm.permShortLabel));`,
    `  _mBtn.ariaLabel="Pick Mode, "+_agyVm.modeLabel;`,
    `  _pBtn.ariaLabel=_agyVm.isPlan?("Pick Permissions, "+_agyVm.permShortLabel+", locked in Plan mode"):("Pick Permissions, "+_agyVm.permShortLabel);`,
    `  if(_mBtn.parentElement!==${el}||_pBtn.parentElement!==${el}){${reset}(${el},_mBtn,_pBtn);}`,
    `  ${el}.ariaLabel=_agyVm.modeLabel+", "+_agyVm.permShortLabel;`,
    `  return null;`,
    `}`,
  ].join('');

  const check = validateSnippetSyntax(
    runtime,
    `function _w(${el},${children},${group},${compact},${renderIcon},${toIcon},${dom},${reset}){`,
    `let ${label}=void 0,${isDefaultIcon}=void 0;return[${label},${isDefaultIcon}];}`,
    'mode-permissions-picker',
  );
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return runtime;
}

module.exports = {
  MODE_SECTION_ID,
  PERMISSIONS_SECTION_ID,
  isAntigravityModeGroup,
  resolveModePermissionsViewModel,
  buildModePermissionsActionItems,
  buildModePermissionsPickerSnippet,
};
