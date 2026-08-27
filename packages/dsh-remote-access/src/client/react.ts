/** 浏览器模块表通过注入的 require 提供 React——从这里导入，而不是重复 require。 */

import type * as ReactNS from 'react';

export const React: typeof ReactNS = require('react');
export const h = React.createElement;
