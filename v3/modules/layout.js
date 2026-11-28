/**
 * Created by rdeso_000 on 2/15/2015.
 */
define(["jquery"],function($){

	return {
		init:function(){
			var self = this;
			require(["kevents","k-template"],function(kevt,ktmpl){
				//kevt.listen("resizeWindow", self.onResizeWindow, self );
				//kevt.listen("SecondTic", this.checkHeader, this );
				kevt.listen("onlogin", self.refreshSession, self);
				kevt.listen("onlogout", self.refreshSession, self);
				ktmpl.processTemplateNode(document.body,SSN);
				//document.body.onmouseup=function(e){
				//	kevt.fire( "mouseUp", {
				//			target:_D(e)?e.target : event.srcElement,
				//			e:_D(e)?e:event
				//		}
				//	);
				//};
				//document.body.onmousedown=function(e){
				//	kevt.fire( "mouseDown", {
				//			target:_D(e)?e.target : event.srcElement,
				//			e:_D(e)?e:event
				//		}
				//	);
				//};

				$(document.body).on("dragstart",function(e){
					e.preventDefault();
				});

				$(document.body).click(function(e){
					var $target = $(e.target), $targetParent = $target.parent();
					if($target.dom().type != "checkbox" && $targetParent.hasClass("radio_frame")){
						$check = $("input[type=checkbox]", $targetParent);
						if($check.dom()){
							$check.dom().checked = $check.dom().checked ? false:true;
						}
					}
					var tip =$target.attr("data-tip");
					if(tip){
						require(["kui"],function(kui){
							RS("help:tip",function(){
								kui.msgbox({
									title:"a.info",
									msg:"help:tips." + tip
								});
							});
						});
					}
				});

				// Keyboard activation for custom menu items. Side-menu group
				// headers, Logout, Refresh, the language switches and the no-href
				// action links carry click handlers on <li>/<a> elements that the
				// browser does not activate natively, so Enter and Space did
				// nothing on them. A focused element with an explicit tabindex
				// that is not a native control gets a synthetic click, which
				// reaches its onclick / jQuery / delegated handlers exactly like
				// a tap does.
				$(document).on("keydown",function(e){
					if(e.key != "Enter" && e.key != " " && e.keyCode != 13 && e.keyCode != 32){
						return;
					}
					if(e.altKey || e.ctrlKey || e.metaKey){
						return;
					}
					var el = e.target;
					if(!el || el == document.body || el.disabled){
						return;
					}
					var tag = (el.tagName || "").toLowerCase();
					if((tag == "a" && el.getAttribute("href"))
						|| tag == "button" || tag == "input" || tag == "select"
						|| tag == "textarea" || tag == "iframe" || tag == "object"
						|| el.isContentEditable || el.getAttribute("contenteditable") != null){
						return;
					}
					if(el.getAttribute("tabindex") === null){
						return;
					}
					if(e.key == " " || e.keyCode == 32){
						// keep Space from scrolling the page
						e.preventDefault();
					}
					el.click();
				});

				document.body.oncontextmenu = function(e){
					if(e.target.src && e.target.src.indexOf("kpic")!=-1){
						return false;
					}
				};

				document.body.onmouseover=function(e){
					kevt.fire( "mouseMotion", {
							target:_D(e)?e.target : event.srcElement,
							e:_D(e)?e:event
						}
					);
				};
				window.onresize = function(){
					kevt.fire("resizeWindow", {
						h:document.documentElement.clientHeight,
						w:document.documentElement.clientWidth
					});
				};
				window.onscroll = function(){
					var docEl = document.documentElement || {};
					var info = {
						x:window.pageXOffset,
						y:window.pageYOffset,
						w:window.innerWidth,
						h:window.innerHeight,
						scrollY: docEl.scrollTop || document.body.scrollTop,
						scrollX: docEl.scrollLeft || document.body.scrollLeft
					};
					kevt.fire("scrollWindow", info);
					Log(info, Log.type.warn);
				};
				window.setInterval(
					function(){
						kevt.fire("SecondTic");
					},
					1000
				);
				window.onresize();
			});
		},
		refreshSession:function(){
			//alert("refreshSession");
			require(["mem-ui","page-nav"],function(imem,pgNav){
				imem.refreshHeader();
				pgNav.reload();
			});
		},
		onResizeWindow:function(info){
			_E("Contents").style.minHeight = ( info.h - 120 ) + "px";
		},
		checkHeader:function(){//sync header with active session
			if( _N(SSN.id) != _GCN("id",0) ){
				this.refreshSession();
				return false;
			}
			return true;
		}
	};

});
