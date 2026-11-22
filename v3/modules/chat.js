define(["jquery","page-nav", "kui", "k-template", "http","utils","dom-utils","top-tabs","ui-selector","check-frame","inline-edit","js-promise"],
function($, $pgNav, $kui, $ktmpl, $http, $u, $du, $tabs, CSelector,CCheckFrame, _inlineEdit, Promise) {
	var module, msgSelector = new CSelector();

	// Extract the numeric message index from a compiled string key like
	// "chat.v2" (the bundle stores <msg value="2"> under key chat.v2).
	function msgIndex(key) {
		return _N(key.split(".").pop().slice(1));
	}

	// Fixed messages are rendered/populated into div#fixed_msg_N and are not
	// covered by the [data-string] binder, so re-apply the translated text
	// whenever the language changes.
	KStrings.onLanguageChange(function refreshFixedMsgs() {
		RS("options:chat", function () {
			$("div[id^='fixed_msg_']").each(function (el) {
				var msg_id = _N(el.id.slice(10));
				var text = _S("options:chat.v" + msg_id);
				if (_D(text) && text.trim().length) {
					el.innerHTML = text;
				}
			});
		});
	});

	return module = {
		requireCSS:["chat"],
		requireStrings:["options:chat","str:chat","contact:contact_m","contact:points", "contact:contact"],

		initMsgTemplate:function(el, $d, $actions){// called from template
			// The template's [data-exists-if] drops .brgr_frame (button + menu)
			// for messages with no available action (e.g. my own message once
			// read) before this runs. Without a .brgr_menu inside el,
			// initMenuBtn falls back to treating the whole .chat_msg as the
			// button and resolves ".menu" from the chat container, so a click
			// on that message opened every message's menu at once.
			if (!$(".brgr_menu", el).dom()) {
				return;
			}
			var $menu = $du.initMenuBtn(el,$d);
			$menu.click(function(e){
				var menu_id = $(e.target).attr("data-menu-id");
				switch(menu_id){
					case "report":
						$kui.showNotImplemented();
						break;
					case "edit":
						require(["popup"], function (popup) {
							var editor = _C("textarea", {style: "width:100%;height:120px"}, $d.body);
												// Find the page viewRoot (contains #ChatBody) for module.onchange()
												var viewRoot = el.closest("#Contents") || el.closest(".page") || document.body;

							popup.open("update_msg", _TXT(_S("a.update") + " #" + $d.msg_index), editor, [
								{
									title: _S("a.save"),
									onclick: function () {
										$http.post({
											scr: $http.api.contact_m,
											data: {
												pd: 1,
												update: $d.id,
												mid: SSN.mate,
												mtid: SSN.mtid,
												msg: editor.value
											},
											onload: function (t, x) {
																	module.onchange(viewRoot);
											}
										});
									}
								},
								{
									title: _S("a.cancel")
								}
							]);
							//setTimeout(function(){editor.focus()},1000);
						});
						break;
					case "delete":
						require(["popup"], function (popup) {
							popup.open("confirm", undefined, "a.sure", [
								{
									title: _S("a.yes"),
									onclick: function () {
										$http.post({
											scr: $http.api.delete_msg,
											data: {
												msg: $d.id,
												mid: SSN.mate,
												mtid: SSN.mtid
											},
											onload: function (t, x) {
												$(el).remove();
											}
										});
									}
								},
								{
									title: _S("a.no"),
									focus: true
								}
							]);
						});

				}
			});
		},
		onload: function (viewRoot) {
			if (!$kui.chkLogin({nav: true})) {
				return;
			}

			// The chat page occupies the full viewport: hide the app shell
			// footer while it is active; ondestroy() restores it on exit.
			$("#Footer").addClass("hidden");

			if (!SSN.mate) {
				$pgNav.open("my", undefined, true, true);
			}
			$tabs.showTab("Menu_Kobool");
			$tabs.select("Kobool.Chat");


			this.initFixedMsgs($(".pdm_frame", viewRoot));

			document.forms.ChatEditor.onsubmit = function () {
				var frm = this;
				frm.msg.value = frm.msg.value.trim();
				frm.live.value = module.live ? "1" : "0";

				var pdata = $u.form2Hash(this);
				pdata.pd = ( frm.rtm && frm.rtm.checked ? 1 : 0 );

				if (!pdata.pd || frm.msg.value.length) {
					$http.post({
						scr: $http.api.contact_m,
						data: pdata,
						onload: function (t, x) {
							var info = $http.xml2JS(x);
							if (_N(info.success)) {
								frm.msg.value = "";
								frm.msg.focus();
								module.onchange(viewRoot);
							} else {
								//TODO: show error
							}
						},
						silent: true
					});
				}
				return false;
			};

			this.ping();
			this.onchange(viewRoot);
			return Promise.as(true);
		},
		ondestroy: function () {
			$("#Footer").removeClass("hidden");
		},
		postRender: function (root, data) {
			// contact:contact_m bundle is loaded by requireStrings before onload,
			// so getString resolves synchronously here. Replace %m% (mate login)
			// and strip %h1%...%h0% (HTML highlights) before setting the intro.
			var $intro = $(".chat_intro_text", root);
			var val = window.KStrings.getString("contact:contact_m.intro");
			if (val) {
				$intro.html( val.replace(/\%m\%/g, SSN.mlogin).replace(/\%h.{1}\%/g, "") );
			}
		},
		onchange:function(viewRoot){
			var $root = $("#ChatBody", viewRoot);

			this.getPage(0).done(function(pageInfo){
				var results = pageInfo.results;
				if(results.can_type!=0){
					$("#chkTyping").dom().checked = true;
					module.toggleTyping();
				}
				if( _N(results.total) ) {
					$root.html("").append(pageInfo.$docFrag);
				}else{
					$root.html("").append("<div class='subtitle'>" + _S("contact:contact_m.no_msgs") + "</div>");
				}
				module.scrollBottom();
			});
		},
		scrollBottom:function(){
			window.scrollTo(0,document.body.scrollHeight - window.innerHeight )
		},
		initFixedMsgs: function (rootEl) {
			var selected_msg;
			var sendBtn = _C("button", {"class": "float_right"}, _S("contact:contact_m.submit"));
			$(sendBtn).click(function(e){
				var frm = document.forms.ChatEditor;
				e.preventDefault();// the native submit would re-run onsubmit (double post)
				frm.msid.value = selected_msg;
				if (typeof frm.onsubmit === "function") {
					frm.onsubmit();
				}
			});

			// The SPA has no server-rendered fixed_msg_* divs in pdm_frame, so
			// populate it from the options:chat string group (same source v2 used).
			// Empty messages render as separators (<hr>). Items are rendered in
			// numeric message-index order: the compiled bundle sorts keys
			// lexicographically (v10 before v2), so sort by the v<N> suffix and
			// write that index into the div id; clicking then sends the right msid.
			var items = window.KStrings.getGroup("options:chat").sort(function (a, b) {
				return msgIndex(a.key) - msgIndex(b.key);
			});
			if (items.length && !$("div", rootEl).dom()) {
				items.forEach(function (item) {
					var msg_id = msgIndex(item.key);
					$du.append(rootEl.dom(), _C("div", {"id": "fixed_msg_" + msg_id}, item.value || ""));
				});
			}

			$("div",rootEl).each(function (el) {
				var msg_id = _N(el.id.substr(10));// "fixed_msg_" is 10 chars; the rest is the message index
				if (_D(el.innerHTML)) {
					if (el.innerHTML.trim().length) {
						$(el).click(function (e) {
							msgSelector.select(this);
							this.insertBefore(sendBtn, this.firstChild);
							sendBtn.focus();
							selected_msg = msg_id;
						});
					} else {
						_A(el, "hr");
					}
				}
			});

		},

		ping: function () {
			if (!document.forms.ChatEditor) {// not in chat page
				return;
			}

			$http.post({
				scr: $http.api.chat_ping,
				data: {
					id: SSN.id,
					mid: SSN.mate,
					t: (document.forms.ChatEditor.msg.value.trim().length ? "1" : "0")
				},
				silent: true,
				onload: function (t, x) {
					var info = $http.xml2JS(x);
					var $pgActions = $("#PageActions");
					if (_N(info.mate_online)) {
						module.live = true;
						if (_N(info.t)) {//typing
							$pgActions.html("<span class='online typing'>" + _S("contact:contact_m.mate_typing").replace(/\%m\%/g, SSN.mlogin) + "</span>")
						} else {
							$pgActions.html("<span class='online'>" + _S("contact:contact_m.mate_online").replace(/\%m\%/g, SSN.mlogin) + "</span>")
						}
						if (_N(info.new_post)) {
							module.onchange();
						}
					} else {
						module.live = false;
						$pgActions.html("<span class='offline'>" + _S("contact:contact_m.mate_offline").replace(/\%m\%/g, SSN.mlogin) + "</span>")
					}

					setTimeout(function () {
						module.ping();
					}, 5000);
				}
			});
		},

		getPage: function (page) {

			var $docFrag = $(document.createDocumentFragment());
			var results;

			return $http.post({
				scr: $http.api.chat_msgs,
				data: {"p": page, js: 1},
				silent: true
			}).then(function (res) {
				results = JSN(res.responseText);

				module.showPStatus(results);
				var msgs = results.child_list;
				var isFirstPage = (msgs === undefined) || (msgs.length == 0) || (msgs[0].msg_index == 1);
				return $ktmpl.render({
						$root:$docFrag,
						tid:".chat_msg",
						data:msgs,
						top_puller:isFirstPage ? null : function(){
							return module.getPage(page + 1);
						}
					},
					results
				);
			}).then(function(){
				return {
					$docFrag:$docFrag,
					results:results
				}
			});
		},

		showPStatus: function (res) {
			$root = $("#Contents");

			$root.removeClass("my_point my_gift mate_point mate_gift");

			switch(_N(res.my_cards) ) {
				case 0:
					break;
				case 1:
					$root.addClass("my_point");
					break;
				default:
					$root.addClass("my_gift");
					break;
			}
			switch (_N(res.mate_cards) ) {
				case 0:
					break;
				case 1:
					$root.addClass("mate_point");
					break;
				default:
					$root.addClass("mate_gift")
			}
			if( _N(res.my_cards) + _N(res.mate_cards) > 1) {
				$root.addClass("no_points_needed");
			}

			$("#MatePointsCount").html(res.mate_cards);
			$("#MyPointsCount").html(res.my_cards);

		},

		toggleTyping:function(){
			var $cBox = $("#Contents");
			var chk = $("#chkTyping").dom();
			if( chk.checked){
				$cBox.addClass("show_typing")
				//$("#ChatTypingBox .chat_editor textarea").focus();
			}else{
				$cBox.removeClass("show_typing")
			}
		}
	};

});
