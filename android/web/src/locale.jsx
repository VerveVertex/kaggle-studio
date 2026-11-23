import React,{createContext,useContext} from 'react';
import {translator} from './i18n.mjs';
export const LocaleContext=createContext('en');
export const useT=()=>translator(useContext(LocaleContext));
