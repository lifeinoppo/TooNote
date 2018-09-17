import debug from '../util/debug';
import * as realm from '../storage/realm';
import * as renderData from './renderData';
import {getOrderNumber, normalizeOrderList} from '../util/orderCalc';
import {getConfig, setConfig} from '../util/config';
import io from '../util/io';
import ioExportNote from './exportNote';
import ioCopyNote from './copyNote';
import {init as versionInit} from './version';
import eventHub, {EVENTS} from '../util/eventHub';
import taskInit from '../task';
import upgrade from '../upgrade';
import {throttle, uniqBy} from 'lodash';

upgrade();

const logger = debug('controller:main');

let results;
let updateRenderData = throttle(renderData.update, 16, {
	leading: false
});

export const uiData = {
	notebookList: {
		data: []
	},
	currentNotebook: {
		data: {}
	},
	currentNote:{
		data: {}
	},
	currentNoteContent:{
		data: ''
	},
	searchNoteList:{
		data: []
	},
	versions: {
		data: {
			list: [],
			currentContent: ''
		}
	},
	layout:{
		data:{
			sidebar: true,
			editor: true,
			preview: true
		}
	}
};

console.time('initRenderData');
realm.init();

versionInit();
taskInit();

results = {
	Notebook: realm.getResults('Notebook'),
	Category: realm.getResults('Category'),
	Note: realm.getResults('Note'),
};
for(let schema in results){
	results[schema].addListener((puppies, changes) => {
		logger('realm data changed');
		logger(puppies);
		logger(changes);
		updateRenderData(results, uiData);
	});
}
console.timeEnd('initRenderData');

/**
 * 尝试恢复上次退出前的状态
 */
export function recoverLastState(){
	console.time('recoverLastState');
	if(!uiData.notebookList.data.length){
		logger('recoverLastState not ready, waiting.');
		setTimeout(recoverLastState, 16);
	}else{
		logger('recoverLastState ready, recovering.');
		const lastState = getConfig('lastState');
		if(!lastState){
			logger('nothing to recover.');
			return;
		}
		switchCurrentNotebook(lastState.notebookId, lastState.noteId);
	}
	console.timeEnd('recoverLastState');
}

/**
 * 切换当前笔记本
 * @param {string} notebookId 笔记本id
 * @returns {void}
 */
export function switchCurrentNotebook(notebookId, noteId){
	console.time('switchCurrentNotebookData');
	renderData.switchCurrentNotebook(results, uiData, notebookId);
	if(!noteId){
		// 切到第一篇笔记
		noteId = uiData.currentNotebook.data.notes[0].id;
	}
	switchCurrentNote(noteId);
	console.timeEnd('switchCurrentNotebookData');
}

/**
 * 创建笔记本
 * @param {string} title 笔记本标题
 * @returns {void}
 */
export function createNotebook(title){
	console.time('createNotebook');
	const notebookId = realm.createNotebook(title);
	// 触发事件
	eventHub.emit(EVENTS.NOTE_CREATED, {id: notebookId});
	console.timeEnd('createNotebook');
}

/**
 * 退出当前笔记本
 */
export function exitNotebook(){
	uiData.currentNotebook.data = {};
}

/**
 * 切换当前笔记
 * @param {string} noteId 笔记id
 * @returns {void}
 */
export function switchCurrentNote(noteId){
	console.time('switchCurrentNoteData');
	renderData.switchCurrentNote(results, uiData, noteId);
	setConfig('lastState', {
		notebookId: uiData.currentNotebook.data.id,
		noteId: noteId
	});
	console.timeEnd('switchCurrentNoteData');
}

/**
 * 更新笔记
 * @param {Object} 更新的数据
 * @returns {void}
 */
export const updateNote = throttle((data, isEditingHeading) => {
	if(!data.id){
		data.id = uiData.currentNote.data.id;
	}

	// 处理通过标题修改分类的情况
	if(data.content && !isEditingHeading){
		const firstLine = data.content.split('\n', 2)[0];
		if(!firstLine){
			data.title = '无标题';
		}else{
			const titlePart = firstLine.replace(/#/g, '')
				.trim().split('\\', 2);
			if(titlePart.length === 2){
				data.title = titlePart[1];
				const categoryTitle = titlePart[0].trim();
				logger('update note category to :', categoryTitle);
				updateNoteCategoryByTitle(data.id, categoryTitle);
			}else{
				data.title = titlePart[0];
			}
		}
	}

	let hasNoteChanged = false;
	let hasNoteContentChaned = false;
	// 判断内容是否更新
	if(typeof data.content !== 'undefined' && data.content !== uiData.currentNoteContent.data){
		logger('content changed.');
		hasNoteContentChaned = true;
	}
	// 判断除内容以外字段是否更新
	let targetNote = uiData.currentNotebook.data.notes.filter((note) => {
		return note.id === data.id;
	})[0];
	for(let key in data){
		if(key !== 'content' && data[key] !== targetNote[key]){
			logger(key + ' changed.');
			hasNoteChanged = true;
		}
	}
	logger('hasNoteChanged', hasNoteChanged, data);

	// 更新DB
	if(!hasNoteChanged && !hasNoteContentChaned) return;
	console.time('updateNote');
	realm.updateResult('Note', data);

	// 触发事件，用于历史版本记录、云服务等
	if(hasNoteContentChaned){
		eventHub.emit(EVENTS.NOTE_CONTENT_CHANGED, data);
	}
	if(hasNoteChanged){
		eventHub.emit(EVENTS.NOTE_CHANGED, data);
	}

	// 更新界面
	renderData.updateNote(uiData, data);
	if(data.id === uiData.currentNote.data.id){
		renderData.updateCurrentNoteContent(uiData, data.content);
	}
	console.timeEnd('updateNote');
}, 500);

/**
 * 删除笔记
 * @param {string} noteId 笔记id
 * @returns {void}
 */
export function deleteNote(noteId){
	console.time('deleteNote');

	// 判断删除的是否是当前笔记
	let isCurrentNote = noteId === uiData.currentNote.data.id;

	// 写入DB
	realm.deleteResult('Note', noteId);

	// 触发事件
	eventHub.emit(EVENTS.NOTE_DELETED, noteId);

	// 如果删除的是当前笔记的话需要切换当前笔记
	if(isCurrentNote){
		logger('currentNote deleted, switching to new currentNote');
		switchCurrentNote(uiData.currentNotebook.data.notes[0].id);
	}
	console.timeEnd('deleteNote');
}

/**
 * 删除分类
 * @param {string} categoryId 分类id
 * @returns {void}
 */
export function deleteCategory(categoryId){
	console.time('deleteCategory');
	let ret = true;
	uiData.currentNotebook.data.categories.forEach((category) => {
		if(category.id === categoryId && category.notes.length){
			alert('该分类不为空，不可删除');
			ret = false;
		}
	});
	if(ret && confirm('确定要删除该分类吗？')){
		realm.deleteResult('Category', categoryId);
		// 触发事件
		eventHub.emit(EVENTS.CATEGORY_DELETED, categoryId);
	}
	console.timeEnd('deleteCategory');
	return ret;
}

/**
 * 新建分类
 * @param {string} title 分类标题
 * @param {string} [afterWhichId] Category对象ID，默认为当前分类
 */
export const createCategory = function(title, afterWhichId){
	console.time('createCategory');
	let afterWhich;
	if(afterWhichId){
		uiData.currentNotebook.data.categories.forEach((category) => {
			if(category.id === afterWhichId){
				afterWhich = category;
			}
		});
	}else{
		afterWhich = uiData.currentNote.data.category;
	}
	// 处理下一个分类的order
	let orderOptions = {
		min: afterWhich.order
	};
	uiData.currentNotebook.data.categories.forEach((category) => {
		if(category.order > afterWhich.order){
			if(!orderOptions.max){
				orderOptions.max = category.order;
			}
			if(category.order < orderOptions.max){
				orderOptions.max = category.order;
			}
		}
	});
	let order = getOrderNumber(orderOptions);
	if(order === false) order = afterWhich.order;
	const categoryData = {
		title: title,
		order: order,
		createdAt: new Date(),
		updatedAt: new Date(),
		notes: []
	};
	// 写DB
	const categoryId = realm.createResult('Category', categoryData, [{
		name: 'Notebook',
		field: 'categories',
		id: uiData.currentNotebook.data.id
	}]);
	// 触发事件
	eventHub.emit(EVENTS.CATEGORY_CREATED, categoryData);
	// 更新UI
	renderData.update(results, uiData);
	console.timeEnd('createCategory');
	return categoryId;
};

/**
 * 修改当前笔记的分类
 * @param {string} noteId	笔记ID
 * @param {string} categoryTitle 新分类的标题
 */
export const updateNoteCategoryByTitle = function(noteId, categoryTitle){
	const targetNote = uiData.currentNotebook.data.notes.filter((note) => {
		return note.id === noteId;
	})[0];
	if(categoryTitle === targetNote.category.title) return;
	console.time('updateNoteCategoryByTitle');
	// todo:需要限定笔记本范围
	const targetCategory = results.Category.filtered(`title="${categoryTitle}"`);
	let categoryId;
	// 如果分类不存在，则新建
	if(!targetCategory.length){
		categoryId = createCategory(categoryTitle);
	}else{
		categoryId = targetCategory[0].id;
	}

	updateNoteCategory(targetNote.id, categoryId);

	console.timeEnd('updateNoteCategoryByTitle');
};

/**
 * 修改笔记的分类
 * @param {string} noteId 笔记ID
 * @param {string} categoryId 新分类的ID
 */
export const updateNoteCategory = function(noteId, categoryId){
	console.time('updateNoteCategory');
	const targetNoteResult = results.Note.filtered(`id="${noteId}"`)[0];
	const oldCategoryId = targetNoteResult.category[0].id;

	// 创建新分类的反向链接
	realm.createReverseLink(targetNoteResult, [{
		name: 'Category',
		field: 'notes',
		id: categoryId
	}]);

	// 移除旧分类的反向链接
	realm.removeReverseLink(targetNoteResult, [{
		name: 'Category',
		field: 'notes',
		id: oldCategoryId
	}]);

	// 检查旧分类是否为空，如果为空，删除它
	deleteEmptyCategory(oldCategoryId);

	// 触发事件
	eventHub.emit(EVENTS.NOTE_CHANGED, {
		categoryId
	});

	// 更新UI
	renderData.updateCurrentNoteCategory(results, uiData, categoryId);
	console.timeEnd('updateNoteCategory');

};

/**
 * 删除空分类
 * @param {string} categoryId 分类ID
 */
export const deleteEmptyCategory = function(categoryId){
	console.time('deleteEmptyCategory');
	const targetCategory = results.Category.filtered(`id="${categoryId}"`)[0];
	if(!targetCategory) return;
	if(targetCategory.notes.length) return;
	realm.deleteResult('Category', categoryId);
	// 触发事件
	eventHub.emit(EVENTS.CATEGORY_DELETED, categoryId);
	console.timeEnd('deleteEmptyCategory');
};

/**
 * 新建笔记
 * @param {Object} data 笔记数据
 */
export const newNote = function(data = {}){
	console.time('newNote');
	const currentNote = uiData.currentNote.data;
	data = Object.assign({
		title: '新笔记',
		content: '# 新笔记\n\n',
		order: getOrderNumber({
			min: currentNote.order
		}),
		localVersion: 1,
		remoteVersion: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	}, data);

	// 写DB
	const newNoteId = realm.createResult('Note', data, [{
		name: 'Category',
		field: 'notes',
		id: currentNote.category.id,
	},{
		name: 'Notebook',
		field: 'notes',
		id: currentNote.notebook.id,
	}]);
	logger('newNoteId:' + newNoteId);

	// 触发事件
	eventHub.emit(EVENTS.NOTE_CREATED, Object.assign({
		id: newNoteId
	}, data));

	// 更新UI
	renderData.update(results, uiData);
	switchCurrentNote(newNoteId);
	console.timeEnd('newNote');
};

/**
 * 切换组件的可视状态
 * @param {string} component 要切换的组件
 * @param {boolean} [value] 切换的值，如果不传，则当前值取反
 */
export const switchLayout = function(component, value){
	const oldValue = uiData.layout.data[component];
	if(typeof value === 'undefined'){
		value = !oldValue;
	}
	uiData.layout.data[component] = value;
};

/**
 * 搜索关键词
 * @param {string} keyword 关键词
 */
export const search = function(keyword){
	console.time('search');
	renderData.search(results, uiData, keyword);
	console.timeEnd('search');
};

/**
 * 导出当前笔记
 * @param {string} format 格式
 */
export const exportNote = function(format){
	console.time('exportNote');
	ioExportNote(format, uiData.currentNote.data.title, uiData.currentNoteContent.data).then(() => {
		console.timeEnd('exportNote');
	});
};

/**
 * 复制当前笔记
 * @param {string} format 格式
 */
export const copyNote = function(format){
	console.time('copyNote');
	ioCopyNote(format, uiData.currentNoteContent.data).then(() => {
		console.timeEnd('copyNote');
	});
};

export const normalizeAllNoteOrder = function(){
	console.time('normalizeAllNoteOrder');
	const allNotes = results.Note.sorted('order');
	const newOrderList = normalizeOrderList({count:allNotes.length});
	const updateList = allNotes.map((noteResult, index) => {
		return {
			id: noteResult.id,
			order: newOrderList[index]
		};
	});
	logger('updateList', updateList);
	realm.updateResult('Note', updateList);
	renderData.update(results, uiData);
	console.timeEnd('normalizeAllNoteOrder');
};

export const updateOrder = function(targetType, id, compareId, compareDirection){

	let doUpdateOrder = function(id, compareId, compareDirection){
		let compareObject, targetObject;
		logger('moving order:', targetType, id);
		let targetList;
		if(targetType === 'Note'){
			targetList = uiData.currentNotebook.data.notes;
		}else{
			targetList = uiData.currentNotebook.data.categories;
		}
		targetList.forEach((target) => {
			if(target.id === compareId){
				compareObject = target;
			}
			if(target.id === id){
				targetObject = target;
			}
		});
		const config = {};
		// 与compare对立的元素
		if(compareDirection === 'up'){
			config.max = compareObject.order;
			// 取前一个最大的order
			let previousTarget = results[targetType].filtered(
				`order < ${compareObject.order}`
			).sorted('order', true);
			if(previousTarget[0]){
				config.min = previousTarget[0].order;
			}
		}else{
			config.min = compareObject.order;
			// 取后一个最小的order
			let nextTarget = results[targetType].filtered(
				`order > ${compareObject.order}`
			).sorted('order');
			if(nextTarget[0]){
				config.max = nextTarget[0].order;
			}
		}
		logger('ready to getOrderNumber', config);
		const newOrder = getOrderNumber(config);
		logger('newOrder:', newOrder);

		if(newOrder === false){
			// logger('newOrder is false, try update all');
			// normalizeAllNoteOrder();

			// 从目标位置往后挪
			// 如果direction是up，则把compareNote往后挪
			// 如果direction是down，则把compareNote的后一个往后挪
			logger('newOrder is false, try to move next node');
			let pendingMovingTarget;
			if(compareDirection === 'up'){
				pendingMovingTarget = compareObject;
			}else if(compareDirection === 'down'){
				pendingMovingTarget = results[targetType].filtered(
					`order > ${compareObject.order}`
				).sorted('order')[0];
			}
			updateNoteOrder(pendingMovingTarget.id, pendingMovingTarget.id, 'down');
			updateNoteOrder(id, compareId, compareDirection);
		}else{
			logger('newOrder ok, ready to update');
			let updateData = {
				order: newOrder,
				id: id
			};
			// 写入DB
			realm.updateResult(targetType, updateData);
			// 触发事件
			if(targetType === 'Note'){
				eventHub.emit(EVENTS.NOTE_CHANGED, updateData);
			}else if(targetType === 'Category'){
				eventHub.emit(EVENTS.CATEGORY_CHANGED, updateData);
			}
			// 更新UI
			renderData.updateNote(uiData, updateData);
		}
	};

	doUpdateOrder(id, compareId, compareDirection);

};

export const updateNoteOrder = function(noteId, compareNoteId, compareDirection){
	console.time('updateNoteOrder');
	const ret = updateOrder('Note', noteId, compareNoteId, compareDirection);
	console.timeEnd('updateNoteOrder');
	return ret;
};

export const updateCategoryOrder = function(categoryId, compareCategoryId, compareDirection){
	console.time('updateCategoryOrder');
	const ret = updateOrder('Category', categoryId, compareCategoryId, compareDirection);
	console.timeEnd('updateCategoryOrder');
	return ret;
};

export const categoryRename = function(categoryId, title){
	if(!title) return;
	console.time('categoryRename');
	const categoryData = {
		id: categoryId,
		title
	};
	realm.updateResult('Category', categoryData);
	// 触发事件
	eventHub.emit(EVENTS.CATEGORY_CHANGED, categoryData);
	console.timeEnd('categoryRename');
};

/**
 * 插入附件
 * @param {Object} data 配置文件
 * @param {string} [data.from] 附件来源 clipboard | file
 * @param {string} [data.path] 附件地址
 * @param {string} [data.ext] 附件后缀名
 */
export const createAttachment = function(data){
	console.time('createAttachment');
	const currentNote = uiData.currentNote.data;
	let filePath = '';
	let fileName = '';
	if(data.from === 'clipboard'){
		filePath = io.saveImageFromClipboard();
		fileName = io.getFileName(filePath);
	}else{
		filePath = io.saveImage(data.path, data.ext);
		fileName = io.getFileName(data.path);
	}
	if(!filePath) return false;

	const ext = io.getFileExt(filePath);
	data = {
		filename: fileName,
		ext,
		size: io.getFileSize(filePath),
		localPath: filePath,
		remotePath: '',
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	const newAttachmentId = realm.createResult('Attachment', data, [{
		name: 'Note',
		field: 'attachments',
		id: currentNote.id,
	}]);
	logger('newAttachmentId:' + newAttachmentId);
	console.timeEnd('createAttachment');
	return {
		id: newAttachmentId,
		filename: fileName,
		ext
	};
};

/**
 * 显示指定笔记的历史版本
 * @param {string} noteId 笔记ID
 */
export const showVersions = function(noteId){
	console.time('showVersions');
	const targetNote = realm.getResults('Note').filtered(`id="${noteId}"`);
	if(!targetNote.length){
		uiData.versions.data.list = [];
	}else{
		uiData.versions.data.list = uniqBy(targetNote[0].versions.sorted('createdAt', true).map((version) => {
			return {
				id: version.id,
				message: version.message,
				createdAt: version.createdAt
			};
		}), 'id');
	}
	console.timeEnd('showVersions');
};

/**
 * 显示指定笔记的历史版本
 */
export const hideVersions = function(){
	uiData.versions.data.list = [];
	uiData.versions.data.currentContent = '';
};

/**
 * 显示当前版本的内容
 * @param {string} versionId
 * @param {string} noteId
 */
export const showVersionContent = function(versionId, noteId){
	console.time('showVersionContent');
	const content = realm.getResults('VersionNoteContent').filtered(`versionId="${versionId}" AND noteId="${noteId}"`);
	if(content.length){
		uiData.versions.data.currentContent = content[0].content;
	}else{
		uiData.versions.data.currentContent = '该版本没有内容变更';
		// console.log('该版本没有内容变更');
	}
	console.timeEnd('showVersionContent');
};
