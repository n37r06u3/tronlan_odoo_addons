odoo.define('web.image_upload', function (require) {
    "use strict";

    var core = require('web.core');
    var session = require('web.session');
    var ListView = require('web.ListView');
    var FormView = require('web.FormView');
    var form_widgets = require('web.form_widgets');
    var form_relational = require('web.form_relational');
    var ViewManager = require('web.ViewManager');
    var ControlPanel = require('web.ControlPanel');
    var utils = require('web.utils');
    var QWeb = core.qweb;
    var _t = core._t;
    var list_widget_registry = core.list_widget_registry;
    var form_widget_registry = core.form_widget_registry;

    var X2ManyList = ListView.List.extend({
        pad_table_to: function (count) {
            if (!this.view.is_action_enabled('create') || this.view.x2m.get('effective_readonly')) {
                this._super(count);
                return;
            }

            this._super(count > 0 ? count - 1 : 0);

            var self = this;
            var columns = _(this.columns).filter(function (column) {
                return column.invisible !== '1';
            }).length;
            if (this.options.selectable) {
                columns++;
            }
            if (this.options.deletable) {
                columns++;
            }

            var $cell = $('<td>', {
                colspan: columns,
                'class': 'oe_form_field_x2many_list_row_add'
            }).append(
                $('<a>', {href: '#'}).text(_t("Add an item"))
                    .click(function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        // FIXME: there should also be an API for that one
                        if (self.view.editor.form.__blur_timeout) {
                            clearTimeout(self.view.editor.form.__blur_timeout);
                            self.view.editor.form.__blur_timeout = false;
                        }
                        self.view.save_edition().done(function () {
                            self.view.do_add_record();
                        });
                    }));

            var $padding = this.$current.find('tr:not([data-id]):first');
            var $newrow = $('<tr>').append($cell);
            // if ($padding.length) {
            //     $padding.before($newrow);
            // } else {
            //     this.$current.append($newrow);
            // }
        },
    });
    var One2ManyGroups = ListView.Groups.extend({
        setup_resequence_rows: function () {
            if (!this.view.x2m.get('effective_readonly')) {
                this._super.apply(this, arguments);
            }
        }
    });
    var X2ManyViewManager = ViewManager.extend({
        init: function (parent, dataset, views, flags, x2many_views) {
            // By default, render buttons and pager in X2M fields, but no sidebar
            var flags = _.extend({}, flags, {
                headless: false,
                search_view: false,
                action_buttons: true,
                pager: true,
                sidebar: false,
            });
            this.control_panel = new ControlPanel(parent, "X2ManyControlPanel");
            this.set_cp_bus(this.control_panel.get_bus());
            this._super(parent, dataset, views, flags);
            this.registry = core.view_registry.extend(x2many_views);
        },
        start: function () {
            this.control_panel.prependTo(this.$el);
            return this._super();
        },
        switch_mode: function (mode, unused) {
            if (mode !== 'form') {
                return this._super(mode, unused);
            }
            var self = this;
            var id = self.x2m.dataset.index !== null ? self.x2m.dataset.ids[self.x2m.dataset.index] : null;
            var pop = new common.FormViewDialog(this, {
                res_model: self.x2m.field.relation,
                res_id: id,
                context: self.x2m.build_context(),

                title: _t("Open: ") + self.x2m.string,
                create_function: function (data, options) {
                    return self.x2m.data_create(data, options);
                },
                write_function: function (id, data, options) {
                    return self.x2m.data_update(id, data, options).done(function () {
                        self.x2m.reload_current_view();
                    });
                },
                alternative_form_view: self.x2m.field.views ? self.x2m.field.views.form : undefined,
                parent_view: self.x2m.view,
                child_name: self.x2m.name,
                read_function: function (ids, fields, options) {
                    return self.x2m.data_read(ids, fields, options);
                },
                form_view_options: {'not_interactible_on_create': true},
                readonly: self.x2m.get("effective_readonly")
            }).open();
            pop.on("elements_selected", self, function () {
                self.x2m.reload_current_view();
            });
        },
    });
    var X2ManyListView = ListView.extend({
        is_valid: function () {
            var self = this;
            if (!this.fields_view || !this.editable()) {
                return true;
            }
            if (_.isEmpty(this.records.records)) {
                return true;
            }
            var fields = this.editor.form.fields;
            var current_values = {};
            _.each(fields, function (field) {
                field._inhibit_on_change_flag = true;
                field.__no_rerender = field.no_rerender;
                field.no_rerender = true;
                current_values[field.name] = field.get('value');
            });
            var cached_records = _.filter(this.dataset.cache, function (item) {
                return !_.isEmpty(item.values)
            });
            var valid = _.every(cached_records, function (record) {
                _.each(fields, function (field) {
                    var value = record.values[field.name];
                    field._inhibit_on_change_flag = true;
                    field.no_rerender = true;
                    field.set_value(_.isArray(value) && _.isArray(value[0]) ? [COMMANDS.delete_all()].concat(value) : value);
                });
                return _.every(fields, function (field) {
                    field.process_modifiers();
                    field._check_css_flags();
                    return field.is_valid();
                });
            });
            _.each(fields, function (field) {
                field.set('value', current_values[field.name], {silent: true});
                field._inhibit_on_change_flag = false;
                field.no_rerender = field.__no_rerender;
            });
            return valid;
        },
    });
    var One2ManyListView = X2ManyListView.extend({
        _template: 'One2Many.uploadlistview',

        init: function (parent, dataset, view_id, options) {
            var self = this;
            this._super(parent, dataset, view_id, _.extend(options || {}, {
                GroupsType: One2ManyGroups,
                ListType: X2ManyList
            }));

            this.on('edit:after', this, this.proxy('_after_edit'));
            this.on('save:before cancel:before', this, this.proxy('_before_unedit'));

            /* detect if the user try to exit the one2many widget */
            core.bus.on('click', this, this._on_click_outside);

            this.dataset.on('dataset_changed', this, function () {
                this._dataset_changed = true;
                this.dataset.x2m._dirty_flag = true;
            });
            this.dataset.x2m.on('load_record', this, function () {
                this._dataset_changed = false;
            });

            this.on('warning', this, function (e) { // In case of a one2many, we do not want any warning which comes from the editor
                e.stop_propagation();
            });
        },
        do_add_record: function () {
            if (this.editable()) {
                this._super.apply(this, arguments);
            } else {
                var self = this;
                new common.SelectCreateDialog(this, {
                    res_model: self.x2m.field.relation,
                    domain: self.x2m.build_domain(),
                    context: self.x2m.build_context(),
                    title: _t("Create: ") + self.x2m.string,
                    initial_view: "form",
                    alternative_form_view: self.x2m.field.views ? self.x2m.field.views.form : undefined,
                    create_function: function (data, options) {
                        return self.x2m.data_create(data, options);
                    },
                    read_function: function (ids, fields, options) {
                        return self.x2m.data_read(ids, fields, options);
                    },
                    parent_view: self.x2m.view,
                    child_name: self.x2m.name,
                    form_view_options: {'not_interactible_on_create': true},
                    on_selected: function () {
                        self.x2m.reload_current_view();
                    }
                }).open();
            }
        },
        do_activate_record: function (index, id) {
            var self = this;
            new common.FormViewDialog(self, {
                res_model: self.x2m.field.relation,
                res_id: id,
                context: self.x2m.build_context(),
                title: _t("Open: ") + self.x2m.string,
                write_function: function (id, data, options) {
                    return self.x2m.data_update(id, data, options).done(function () {
                        self.x2m.reload_current_view();
                    });
                },
                alternative_form_view: self.x2m.field.views ? self.x2m.field.views.form : undefined,
                parent_view: self.x2m.view,
                child_name: self.x2m.name,
                read_function: function (ids, fields, options) {
                    return self.x2m.data_read(ids, fields, options);
                },
                form_view_options: {'not_interactible_on_create': true},
                readonly: !this.is_action_enabled('edit') || self.x2m.get("effective_readonly")
            }).open();
        },
        do_button_action: function (name, id, callback) {
            if (!_.isNumber(id)) {
                this.do_warn(_t("Action Button"),
                    _t("The o2m record must be saved before an action can be used"));
                return;
            }
            var parent_form = this.x2m.view;
            var self = this;
            this.save_edition().then(function () {
                if (parent_form) {
                    return parent_form.save();
                } else {
                    return $.when();
                }
            }).done(function () {
                var ds = self.x2m.dataset;
                var changed_records = _.find(ds.cache, function (record) {
                    return record.to_create || record.to_delete || !_.isEmpty(record.changes);
                });
                if (!self.x2m.options.reload_on_button && !changed_records) {
                    self.handle_button(name, id, callback);
                } else {
                    self.handle_button(name, id, function () {
                        self.x2m.view.reload();
                    });
                }
            });
        },
        start_edition: function (record, options) {
            if (!this.__focus) {
                this._on_focus_one2many();
            }
            return this._super(record, options);
        },
        reload_content: function () {
            var self = this;
            if (self.__focus) {
                self._on_blur_one2many();
                return this._super().then(function () {
                    var record_being_edited = self.records.get(self.editor.form.datarecord.id);
                    if (record_being_edited) {
                        self.start_edition(record_being_edited);
                    }
                });
            }
            return this._super();
        },
        _on_focus_one2many: function () {
            if (!this.editor.is_editing()) {
                return;
            }
            this.dataset.x2m.internal_dataset_changed = true;
            this._dataset_changed = false;
            this.__focus = true;
        },
        _on_click_outside: function (e) {
            if (this.__ignore_blur || !this.editor.is_editing()) {
                return;
            }

            var $target = $(e.target);

            // If click on a button, a ui-autocomplete dropdown or modal-backdrop, it is not considered as a click outside
            var click_outside = ($target.closest('.ui-autocomplete,.btn,.modal-backdrop').length === 0);

            // Check if click inside the current list editable
            var $o2m = $target.closest(".oe_list_editable");
            if ($o2m.length && $o2m[0] === this.el) {
                click_outside = false;
            }

            // Check if click inside a modal which is on top of the current list editable
            var $modal = $target.closest(".modal");
            if ($modal.length) {
                var $currentModal = this.$el.closest(".modal");
                if ($currentModal.length === 0 || $currentModal[0] !== $modal[0]) {
                    click_outside = false;
                }
            }

            if (click_outside) {
                this._on_blur_one2many();
            }
        },
        _on_blur_one2many: function () {
            if (this.__ignore_blur) {
                return $.when();
            }

            this.__ignore_blur = true;
            this.__focus = false;
            this.dataset.x2m.internal_dataset_changed = false;

            var self = this;
            return this.save_edition().done(function () {
                if (self._dataset_changed) {
                    self.dataset.trigger('dataset_changed');
                }
            }).always(function () {
                self.__ignore_blur = false;
            });
        },
        _after_edit: function () {
            this.editor.form.on('blurred', this, this._on_blur_one2many);

            // The form's blur thing may be jiggered during the edition setup,
            // potentially leading to the x2m instasaving the row. Cancel any
            // blurring triggered the edition startup here
            this.editor.form.widgetFocused();
        },
        _before_unedit: function () {
            this.editor.form.off('blurred', this, this._on_blur_one2many);
        },
        do_delete: function (ids) {
            var confirm = window.confirm;
            window.confirm = function () {
                return true;
            };
            try {
                return this._super(ids);
            } finally {
                window.confirm = confirm;
            }
        },
        reload_record: function (record, options) {
            if (!options || !options.do_not_evict) {
                // Evict record.id from cache to ensure it will be reloaded correctly
                this.dataset.evict_record(record.get('id'));
            }

            return this._super(record);
        },
    });
    var One2ManyFormView = FormView.extend({
        form_template: 'One2Many.formview',
        load_form: function (data) {
            this._super(data);
            var self = this;
            this.$buttons.find('button.oe_form_button_create').click(function () {
                self.save().done(self.on_button_new);
            });
        },
        do_notify_change: function () {
            if (this.dataset.parent_view) {
                this.dataset.parent_view.do_notify_change();
            } else {
                this._super.apply(this, arguments);
            }
        }
    });
    var FieldX2Many = form_relational.AbstractManyField.extend({
        multi_selection: false,
        disable_utility_classes: true,
        x2many_views: {},
        view_options: {},
        default_view: 'tree',
        init: function (field_manager, node) {
            this._super(field_manager, node);
            this.is_loaded = $.Deferred();
            this.initial_is_loaded = this.is_loaded;
            this.is_started = false;
            this.set_value([]);
        },
        start: function () {
            this._super.apply(this, arguments);
            this.$el.addClass('oe_form_field');
            var self = this;
            this.load_views();
            var destroy = function () {
                self.is_loaded = self.is_loaded.then(function () {
                    self.viewmanager.destroy();
                    return $.when(self.load_views()).done(function () {
                        self.reload_current_view();
                    });
                });
            };
            this.is_loaded.done(function () {
                self.on("change:effective_readonly", self, destroy);
            });
            this.view.on("on_button_cancel", this, destroy);
            this.is_started = true;
            this.reload_current_view();
        },
        load_views: function () {
            var self = this;

            var view_types = this.node.attrs.mode;
            view_types = !!view_types ? view_types.split(",") : [this.default_view];
            var views = [];
            _.each(view_types, function (view_type) {
                if (!_.include(["list", "tree", "graph", "kanban"], view_type)) {
                    throw new Error(_.str.sprintf(_t("View type '%s' is not supported in X2Many."), view_type));
                }
                var view = {
                    view_id: false,
                    view_type: view_type === "tree" ? "list" : view_type,
                    options: {}
                };
                if (self.field.views && self.field.views[view_type]) {
                    view.embedded_view = self.field.views[view_type];
                }
                if (view.view_type === "list") {
                    _.extend(view.options, {
                        addable: null,
                        selectable: self.multi_selection,
                        sortable: true,
                        import_enabled: false,
                        deletable: true
                    });
                    if (self.get("effective_readonly")) {
                        _.extend(view.options, {
                            deletable: null,
                            reorderable: false,
                        });
                    }
                } else if (view.view_type === "kanban") {
                    _.extend(view.options, {
                        confirm_on_delete: false,
                    });
                    if (self.get("effective_readonly")) {
                        _.extend(view.options, {
                            action_buttons: false,
                            quick_creatable: false,
                            creatable: false,
                            read_only_mode: true,
                        });
                    }
                }
                views.push(view);
            });
            this.views = views;

            this.viewmanager = new X2ManyViewManager(this, this.dataset, views, this.view_options, this.x2many_views);
            this.viewmanager.x2m = self;
            var def = $.Deferred().done(function () {
                self.initial_is_loaded.resolve();
            });
            this.viewmanager.on("controller_inited", self, function (view_type, controller) {
                controller.x2m = self;
                if (view_type == "list") {
                    if (self.get("effective_readonly")) {
                        controller.on('edit:before', self, function (e) {
                            e.cancel = true;
                        });
                        _(controller.columns).find(function (column) {
                            if (!(column instanceof list_widget_registry.get('field.handle'))) {
                                return false;
                            }
                            column.modifiers.invisible = true;
                            return true;
                        });
                    }
                } else if (view_type == "graph") {
                    self.reload_current_view();
                }
                def.resolve();
            });
            this.viewmanager.on("switch_mode", self, function (n_mode) {
                $.when(self.commit_value()).done(function () {
                    if (n_mode === "list") {
                        $.async_when().done(function () {
                            self.reload_current_view();
                        });
                    }
                });
            });
            $.async_when().done(function () {
                if (!self.isDestroyed()) {
                    self.viewmanager.appendTo(self.$el);
                }
            });
            return def;
        },
        reload_current_view: function () {
            var self = this;
            self.is_loaded = self.is_loaded.then(function () {
                var view = self.get_active_view();
                if (view.type === "list") {
                    view.controller.page = 0;
                    return view.controller.reload_content();
                } else if (view.controller.do_search) {
                    return view.controller.do_search(self.build_domain(), self.dataset.get_context(), []);
                }
            }, undefined);
            return self.is_loaded;
        },
        get_active_view: function () {
            /**
             * Returns the current active view if any.
             */
            return (this.viewmanager && this.viewmanager.active_view);
        },
        set_value: function (value_) {
            var self = this;
            this._super(value_).then(function () {
                if (self.is_started && !self.no_rerender) {
                    return self.reload_current_view();
                }
            });
        },
        commit_value: function () {
            var view = this.get_active_view();
            if (view && view.type === "list" && view.controller.__focus) {
                return $.when(this.mutex.def, view.controller._on_blur_one2many());
            }
            return this.mutex.def;
        },
        is_syntax_valid: function () {
            var view = this.get_active_view();
            if (!view) {
                return true;
            }
            switch (this.viewmanager.active_view.type) {
                case 'form':
                    return _(view.controller.fields).chain()
                        .invoke('is_valid')
                        .all(_.identity)
                        .value();
                case 'list':
                    return view.controller.is_valid();
            }
            return true;
        },
        is_false: function () {
            return _(this.dataset.ids).isEmpty();
        },
    });
    var FieldOne2Many = FieldX2Many.extend({
        events: {
            'change .o_form_file_upload_input': 'set_order_line',
        },
        get_line_value: function(id) {
            var data = _.clone(this.lunch_data[id]);
            if (typeof this.lunch_data[id]['product_id'][0] != 'undefined'){
                data['product_id'] = this.lunch_data[id]['product_id'][0];
            }
            return data;
        },
        set_order_line: function(event) {
            var self = this;
            _.each(event.target.files, function(file, index){
                var filereader = new FileReader();
                filereader.readAsDataURL(file);
                filereader.onloadend = function(upload) {
                    var data = upload.target.result;
                    data = data.split(',')[1];
                    var attachment_ids = self.field_manager.fields.attachment_ids;
                    attachment_ids.data_create({'picture':data});
                    attachment_ids.reload_current_view();
                };
                })
        },
        init: function () {
            this._super.apply(this, arguments);
            this.x2many_views = {
                form: One2ManyFormView,
                kanban: core.view_registry.get('one2many_kanban'),
                list: One2ManyListView,
            };
        },
        start: function () {
            this.$el.addClass('oe_form_field_one2many');
            return this._super.apply(this, arguments);
        },
        commit_value: function () {
            var self = this;
            return this.is_loaded.then(function () {
                var view = self.viewmanager.active_view;
                if (view.type === "list" && view.controller.editable()) {
                    return self.mutex.def.then(function () {
                        return view.controller.save_edition();
                    });
                }
                return self.mutex.def;
            });
        },
    });

    form_widget_registry.add('form-image-upload', FieldOne2Many)

});
