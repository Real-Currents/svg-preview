/*
 * Copyright (c) 2012 Adobe Systems Incorporated.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50, regexp: true */
/*global define, brackets, $ */

define(function (require, exports, module) {
    "use strict";
    
    // Brackets modules
    var MainViewManager         = brackets.getModule("view/MainViewManager"),
        EditorManager           = brackets.getModule("editor/EditorManager"),
        WorkspaceManager        = brackets.getModule("view/WorkspaceManager"),
        ExtensionUtils          = brackets.getModule("utils/ExtensionUtils");
    
    // Extension's own modules
    var XMLPathFinder           = require("XMLPathFinder");
    
    
    // TODO:
    //  - source->image linkage -- blink element in SVG (if Live Highlight is toggled on)
    //      - blink element's fill red/normal/red/normal a few times when cursor enters its text bounds
    //      - (during NON-EDIT cursor movement only... how to detect??)
    
    /**
     * Preview panel that appears above the editor area. Lazily created, so may be null if never shown yet.
     * @type {?jQuery}
     */
    var $svgPanel;
    
    /** @type {boolean}  True if panel has just been shown/hidden */
    var needsWorkspaceLayout;
    
    /** @type {?Editor} */
    var currentEditor;
    
    /** State of the panel for the currently viewed Document, or null if panel not currently shown
     *  @type {?{zoomFactor:number}} */
    var currentState;
    
    
    function setPanelHeight(height) {
        if (height !== $svgPanel.lastHeight || needsWorkspaceLayout) {
            $svgPanel.height(height);
            $svgPanel.lastHeight = height;
            
            WorkspaceManager.recomputeLayout();
            needsWorkspaceLayout = false;
        }
    }
    
    function updateSize($svgParent, $svgRoot) {
        // Get size of the SVG image (which is always explicitly specified on root tag)
        var svgWidth, svgHeight;
        var viewBoxAttr = $svgRoot[0].getAttribute("viewBox"); // jQ can't read this attr - see below
        if (viewBoxAttr) {
            var boundsStrs = viewBoxAttr.split(/[ ,]+/);
            svgWidth = parseFloat(boundsStrs[2]);
            svgHeight = parseFloat(boundsStrs[3]);
        } else {
            svgWidth = parseInt($svgRoot.attr("width"), 10);
            svgHeight = parseInt($svgRoot.attr("height"), 10);
        }
        
        // Specify actual width consistent with zoom factor
        var viewWidth = svgWidth * currentState.zoomFactor;
        var viewHeight = svgHeight * currentState.zoomFactor;
        
        // Clip to max of 2/3 window ht
        var maxHeight = $(".content").height() * 2 / 3;
        if (viewHeight > maxHeight) {
            viewHeight = maxHeight;
            viewWidth = maxHeight * svgWidth / svgHeight;
        }
        $(".svg-tb-button.zoom11-icon", $svgPanel).toggleClass("disabled", svgHeight > maxHeight);
        $(".svg-tb-button.zoomin-icon", $svgPanel).toggleClass("disabled", viewHeight * 2 > maxHeight);
        
        $(".svg-tb-label", $svgPanel).text((viewWidth / svgWidth) * 100 + "%");
        
        // jQ auto lowercases the attr name, making it ignored (http://bugs.jquery.com/ticket/11166 wontfix: "we don't support SVG")
        $svgRoot[0].setAttribute("viewBox", "0 0 " + svgWidth + " " + svgHeight);
        $svgRoot.attr("width", viewWidth);
        $svgRoot.attr("height", viewHeight);
        
        
        var desiredPanelHeight = $(".svg-toolbar", $svgPanel).outerHeight() + viewHeight + (15 * 2);
        setPanelHeight(desiredPanelHeight);
        
        $svgParent.width(viewWidth);
        $svgParent.height(viewHeight);
    }
    
    /**
     * Re-renders the SVG preview in the panel, automatically sizing it (and the overall panel) to
     * reflect the explicitly set size of the SVG content (modulo the current zoom).
     */
    function updatePanel(editor) {
        var $svgParent = $(".svg-preview", $svgPanel);
        $svgParent.html(editor.document.getText());
        var $svgRoot = $svgParent.children();
        
        if (!$svgRoot.length) {  // empty document
            return;
        }
        
        updateSize($svgParent, $svgRoot);
    }
    
    
    /** Clicking in SVG content selects the corresponding tag in the code */
    function handleSVGClick(event) {
        // Figure out what was clicked
        var clickedNode = event.target;
        if (clickedNode.correspondingUseElement) {
            // If it's an instantiation of a <defs> item, let's target the <use> (aka the instance)
            // (TODO: option to target the node inside <defs> instead, via correspondingElement)
            clickedNode = clickedNode.correspondingUseElement;
        }
        
        // Generate ancestor chain of the clicked node
        var nodeChain = [];
        var svgRoot = event.currentTarget;
        var node = clickedNode;
        while (node && node !== svgRoot) {
            nodeChain.unshift(node);
            node = node.parentElement;
        }
//        console.log("CLICK on", event.target);
//        console.log("nodeChain =", nodeChain);
        
        // Generate nth-child lookup info
        var chain = [];
        nodeChain.forEach(function (node) {
            var childIndex = $(node).index();
            chain.push({ childIndex: childIndex, tagName: node.tagName });
            
//            console.log(node.tagName + ", child #" + childIndex);
        });
        
        // Find that same tag in the code
        var startOfOpenTag = XMLPathFinder.findTag(currentEditor, chain);
        if (startOfOpenTag) {
            // Select it
            var lineNum = startOfOpenTag.pos.line;
            var token = startOfOpenTag.token;
            currentEditor.setSelection({line: lineNum, ch: token.start}, {line: lineNum, ch: token.end}, true);
        }
    }
    
    
    function populateToolbar($svgToolbar) {
        var html = "";
        
        html += "<div class='svg-bgswatch checker' title='Checkerboard'></div>";
        html += "<div class='svg-bgswatch' style='background-color:white' title='#FF'></div>";
        html += "<div class='svg-bgswatch' style='background-color:#EEEEEE' title='#EE'></div>";
        html += "<div class='svg-bgswatch' style='background-color:#C0C0C0' title='#C0'></div>";
        html += "<div class='svg-bgswatch' style='background-color:#808080' title='#80'></div>";
        html += "<div class='svg-bgswatch' style='background-color:#404040' title='#40'></div>";
        html += "<div class='svg-bgswatch' style='background-color:black' title='#00'></div>";
        
        html += "<div class='svg-tb-button zoomin-icon' data-zoomFactor='2.0' title='Zoom in'></div>";
        html += "<div class='svg-tb-button zoomout-icon' data-zoomFactor='0.5' title='Zoom out'></div>";
        html += "<div class='svg-tb-button zoom11-icon' title='Restore zoom'></div>";
        html += "<span class='svg-tb-label'></span>";
        
        $svgToolbar.html(html);
        
        $(".svg-bgswatch", $svgToolbar).click(function (event) {
            var $elt = $(event.target);
            var $svgParent = $(".svg-preview", $svgPanel);
            if ($elt.hasClass("checker")) {
                $svgParent.addClass("checker");
            } else {
                $svgParent.removeClass("checker");
                $svgParent.css("background-color", $elt.css("background-color"));
            }
        });
        
        $(".svg-tb-button", $svgToolbar).click(function (event) {
            var $btn = $(event.currentTarget);
            if ($btn.is(".disabled")) { return; }
            
            var zoomFactor = $btn.attr("data-zoomFactor");
            if (isNaN(zoomFactor)) {
                currentState.zoomFactor = 1;
            } else {
                currentState.zoomFactor *= zoomFactor;
            }
            updatePanel(EditorManager.getCurrentFullEditor());
        });
    }
    
    function createSVGPanel() {
        // Create panel contents
        $svgPanel = $("<div class='svg-panel inline-widget no-focus'><div class='shadow top'></div><div class='shadow bottom'></div></div>");
        $svgPanel.append("<div class='svg-toolbar'></div><div class='svg-preview checker' style='margin: 15px'></div>");
        var $svgToolbar = $(".svg-toolbar", $svgPanel);
        populateToolbar($svgToolbar);
        
        // Listeners other than toobar
        $(".svg-preview", $svgPanel).click(handleSVGClick);
    }
    
    
    function handleDocumentChange(jqEvent, doc) {
        console.assert(EditorManager.getCurrentFullEditor() && EditorManager.getCurrentFullEditor().document === doc);
        
        updatePanel(EditorManager.getCurrentFullEditor());
    }
    
    /**
     */
    function attachToEditor(editor) {
        // Per-editor panel state
        if (!editor.svgPanelState) {
            editor.svgPanelState = {
                zoomFactor: 1, // start at 100%
                editor: editor
            };
        }
        currentState = editor.svgPanelState;
        
        // Update panel when text changes
        editor.document.on("change", handleDocumentChange);
        handleDocumentChange(null, editor.document);  // initial update
        
        currentEditor = editor;
    }
    
    function detachFromLastEditor() {
        if (currentEditor) {
            currentEditor.document.off("change", handleDocumentChange);
            currentState = null;
            currentEditor = null;
        }
    }
    
    function showSVGPanel(editor) {
        if (!$svgPanel) {
            createSVGPanel();
            
            // Inject panel into UI
            // TODO: use PanelManager to create top panel, once possible
            $("#editor-holder").before($svgPanel);
            needsWorkspaceLayout = true;
            
        } else if ($svgPanel.is(":hidden")) {
            $svgPanel.show();
            needsWorkspaceLayout = true;
        }
        
        attachToEditor(editor);
    }
    
    function hideSVGPanel() {
        if ($svgPanel && $svgPanel.is(":visible")) {
            $svgPanel.hide();
            WorkspaceManager.recomputeLayout();
        }
    }
    
    /**
     */
    function handleCurrentEditorChange() {
        detachFromLastEditor();
        
        var newEditor = EditorManager.getCurrentFullEditor();
        if (newEditor) {
            if (newEditor.document.getLanguage().getId() === "svg") {
                showSVGPanel(newEditor);
            } else {
                hideSVGPanel();
            }
        } else {
            hideSVGPanel();
        }
    }
    

    // Listen for editors to attach to
    MainViewManager.on("currentFileChange", handleCurrentEditorChange);
    
    ExtensionUtils.loadStyleSheet(module, "svg-preview.css")
        .done(function () {
            // Don't pick up initially visible editor until our stylesheet is loaded
            handleCurrentEditorChange();
        });
});
